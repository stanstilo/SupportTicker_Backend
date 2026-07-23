/**
 * Thin façade over the Python TTS service (see ../tts-service).
 *
 * Speech is NOT synthesized in Node any more. This module only orchestrates:
 * it forwards {text, language} to the Python engine (espeak-ng + phonemizer +
 * IPA lexicon) over HTTP and shapes the response for the /assistant/tts route.
 *
 * Configure the engine location with `TTS_SERVICE_URL` (default
 * http://127.0.0.1:8081). When it's unset/unreachable, this returns a
 * `fallback` result so the browser uses its local speech synthesis — the app
 * keeps working, just without the server voice.
 *
 * The Python service owns caching, the three-tier fallback policy, and the
 * unsupported-language rules; Node deliberately holds no TTS logic.
 */

// Accept a bare host:port (e.g. Render's `hostport`) by defaulting the scheme.
function normalizeBase(url: string): string {
  const trimmed = url.trim().replace(/\/$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

const TTS_SERVICE_URL = normalizeBase(process.env.TTS_SERVICE_URL ?? 'http://127.0.0.1:8081')
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS ?? 15000)
const MAX_TEXT = 1200 // guard against very long inputs (engine caps again)

export interface TtsResult {
  audioBase64: string | null
  /** Content type of the audio (wav by default; mpeg when the engine emits MP3). */
  mime: string
  /** True when the server can't synthesize (unsupported language, engine down,
   *  or explicit Tier-3 unavailable) and the client should fall back to browser
   *  speech synthesis. */
  fallback: boolean
  /** True when the pronunciation is approximate (no native voice for the
   *  language; rendered from IPA via a near voice). */
  approx?: boolean
  /** Human-readable note for the UI (e.g. approximate-pronunciation warning). */
  warning?: string | null
  /** espeak-ng voice actually used, when known. */
  voice?: string | null
  /** Resolved app language. */
  language?: string | null
  /** IPA transcription, when the engine computed one. */
  ipa?: string | null
}

function fallbackResult(warning: string, language?: string): TtsResult {
  return { audioBase64: null, mime: 'audio/mpeg', fallback: true, warning, language: language ?? null }
}

/**
 * Ask the Python engine to synthesize `text` in the given app language. Never
 * throws — a timeout, network error, or non-2xx response degrades to a
 * `fallback` result so the caller (and browser) can carry on.
 */
export async function synthesizeSpeech(rawText: string, appLang: string | undefined): Promise<TtsResult> {
  const text = (rawText || '').trim().slice(0, MAX_TEXT)
  const language = (appLang || 'en').toLowerCase()
  if (!text) return fallbackResult('Empty text.', language)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS)
  try {
    const res = await fetch(`${TTS_SERVICE_URL}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, language }),
      signal: controller.signal,
    })
    if (!res.ok) return fallbackResult(`TTS service returned ${res.status}.`, language)
    const data = (await res.json()) as Partial<TtsResult>
    return {
      audioBase64: data.audioBase64 ?? null,
      mime: data.mime ?? 'audio/wav',
      fallback: data.fallback ?? data.audioBase64 == null,
      approx: data.approx ?? false,
      warning: data.warning ?? null,
      voice: data.voice ?? null,
      language: data.language ?? language,
      ipa: data.ipa ?? null,
    }
  } catch (err) {
    // AbortError (timeout) or connection refused (engine not running).
    return fallbackResult(`TTS service unreachable: ${(err as Error).message}`, language)
  } finally {
    clearTimeout(timer)
  }
}
