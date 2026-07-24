/**
 * Server-side speech-to-text. Two providers, tried in order:
 *
 *   1. Self-hosted Whisper (faster-whisper) in the Python service — PRIMARY.
 *      No billing and no dependency on Google's speech servers (which corporate
 *      networks often block). Reached over HTTP at `STT_SERVICE_URL` (defaults
 *      to `TTS_SERVICE_URL`, i.e. the same Python service).
 *
 *   2. OpenAI Whisper — FALLBACK. Used only when the self-hosted service is
 *      unreachable or can't transcribe, and `OPENAI_API_KEY` is set (and has
 *      quota). Pick the model with `OPENAI_STT_MODEL` (default `whisper-1`).
 *
 * Never throws: when neither provider can transcribe, returns a `fallback`
 * result so the client can fall back to browser recognition or ask the user to
 * type. The most informative warning is preserved for logs.
 */

// Self-hosted Whisper can take longer than a cloud call (CPU inference, and a
// cold model load on first use) — give it a generous timeout.
const STT_SERVICE_TIMEOUT_MS = Number(process.env.STT_SERVICE_TIMEOUT_MS ?? 90000)
const OPENAI_STT_TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS ?? 30000)
// Guard against oversized clips (base64 inflates ~1.37x under the 30MB body limit).
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

// Whisper language hints use ISO-639-1. Only send a hint for languages Whisper
// supports — Igbo ('ig') isn't in its set, so we omit the hint and let the
// model auto-detect rather than send an unsupported code (which errors).
const WHISPER_LANGS: Record<string, string> = { en: 'en', yo: 'yo', ha: 'ha' }

export interface SttResult {
  /** Recognised text ('' when nothing was transcribed). */
  text: string
  /** Detected/assumed language code, when known. */
  language: string | null
  /** True when transcription couldn't run (no provider, timeout, API error, or
   *  empty audio) and the client should fall back to browser recognition or
   *  ask the user to type. */
  fallback: boolean
  /** Human-readable note for logs / the UI. */
  warning?: string | null
  /** Which provider produced this result ('whisper-local' | 'openai' | 'none'). */
  provider?: string
  /** When `fallback`: true → transcription ran but was unclear (ask the user to
   *  repeat); false → the engine couldn't run (switch engines / configure). */
  retryable?: boolean
  /** True when STT isn't available for this language at all (e.g. Igbo) — the
   *  client should ask the user to type rather than retry. */
  unsupported?: boolean
}

// Accept a bare host:port (e.g. Render's `hostport`) by defaulting the scheme.
function normalizeBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

/** Base URL of the self-hosted Whisper service (falls back to the TTS service). */
function sttServiceUrl(): string | null {
  const raw = process.env.STT_SERVICE_URL?.trim() || process.env.TTS_SERVICE_URL?.trim()
  // Default to the co-located Python service on the conventional port.
  return normalizeBase(raw || 'http://127.0.0.1:8081')
}

function fallbackResult(warning: string, language: string, provider = 'none', retryable = false): SttResult {
  return { text: '', language, fallback: true, warning, provider, retryable }
}

function extensionFor(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('ogg')) return 'ogg'
  return 'webm'
}

/** PRIMARY: self-hosted Whisper via the Python service. */
async function transcribeWithService(
  base64: string,
  mime: string,
  language: string,
  partial = false,
): Promise<SttResult> {
  const base = sttServiceUrl()
  if (!base) return fallbackResult('No STT service URL configured.', language, 'whisper-local')

  // Interim partials must return fast; the final pass gets the full timeout.
  const timeoutMs = partial ? Math.min(STT_SERVICE_TIMEOUT_MS, 15000) : STT_SERVICE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioBase64: base64, mime, language, partial }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return fallbackResult(`Whisper service returned ${res.status}. ${detail.slice(0, 200)}`, language, 'whisper-local')
    }
    const data = (await res.json()) as Partial<SttResult>
    const text = (data.text ?? '').trim()
    if (data.fallback || !text) {
      const r = fallbackResult(
        data.warning || 'Whisper service could not transcribe.',
        data.language ?? language,
        'whisper-local',
        data.retryable ?? false,
      )
      r.unsupported = data.unsupported ?? false
      return r
    }
    return { text, language: data.language ?? language, fallback: false, warning: null, provider: 'whisper-local' }
  } catch (err) {
    return fallbackResult(`Whisper service unreachable: ${(err as Error).message}`, language, 'whisper-local')
  } finally {
    clearTimeout(timer)
  }
}

/** FALLBACK: OpenAI audio transcription. */
async function transcribeWithOpenAI(buffer: Buffer, mime: string, language: string): Promise<SttResult> {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) return fallbackResult('OPENAI_API_KEY is not configured.', language, 'openai')
  const model = process.env.OPENAI_STT_MODEL?.trim() || 'whisper-1'

  const type = /^audio\//i.test(mime) ? mime : 'audio/webm'
  const form = new FormData()
  form.append('file', new Blob([buffer], { type }), `audio.${extensionFor(type)}`)
  form.append('model', model)
  const hint = WHISPER_LANGS[language]
  if (hint) form.append('language', hint)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPENAI_STT_TIMEOUT_MS)
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: controller.signal,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return fallbackResult(`OpenAI STT returned ${res.status}. ${detail.slice(0, 200)}`, language, 'openai')
    }
    const data = (await res.json()) as { text?: string; language?: string }
    const text = (data.text ?? '').trim()
    if (!text) return fallbackResult('No speech detected.', language, 'openai')
    return { text, language: data.language ?? language, fallback: false, warning: null, provider: 'openai' }
  } catch (err) {
    return fallbackResult(`OpenAI STT unreachable: ${(err as Error).message}`, language, 'openai')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Transcribe a base64-encoded audio clip in the given app language. `appLang`
 * is the app's language code (en|ig|yo|ha); it becomes a Whisper hint only when
 * supported. Tries the self-hosted service first, then OpenAI. Never throws.
 */
export async function transcribeAudio(
  audioBase64: string,
  mime: string | undefined,
  appLang: string | undefined,
  partial = false,
): Promise<SttResult> {
  const language = (appLang || 'en').toLowerCase()

  // Accept either a bare base64 string or a full data: URL.
  const base64 = (audioBase64 || '').replace(/^data:[^;]+;base64,/, '').trim()
  if (!base64) return fallbackResult('Empty audio.', language)

  let buffer: Buffer
  try {
    buffer = Buffer.from(base64, 'base64')
  } catch {
    return fallbackResult('Invalid audio encoding.', language)
  }
  if (buffer.length === 0) return fallbackResult('Empty audio.', language)
  if (buffer.length > MAX_AUDIO_BYTES) return fallbackResult('Audio clip is too large.', language)

  const type = mime && /^audio\//i.test(mime) ? mime : 'audio/webm'

  // 1) Self-hosted Whisper — primary. Interim partials use the local engine
  //    only (never OpenAI) and return whatever was decoded.
  const local = await transcribeWithService(base64, type, language, partial)
  if (partial || !local.fallback) return local
  // STT genuinely unavailable for this language (e.g. Igbo) → OpenAI can't help
  // either; return so the client tells the user to type.
  if (local.unsupported) return local
  // Transcription ran but was unclear → ask the user to repeat rather than
  // burning the same audio on OpenAI (which won't help and is often out of quota).
  if (local.retryable) return local

  // 2) OpenAI — fallback (only if a key is set and has quota).
  const openai = await transcribeWithOpenAI(buffer, type, language)
  if (!openai.fallback) return openai

  // Neither worked. Surface the OpenAI warning if it actually tried (key set),
  // otherwise the self-hosted one, so logs point at the real blocker.
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY?.trim()
  return hasOpenAIKey ? openai : local
}
