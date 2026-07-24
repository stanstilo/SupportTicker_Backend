/**
 * Thin proxy to the Python translation service (deep_translator / Google
 * Translate). Lets the assistant accept questions in Igbo/Yorùbá/Hausa: the
 * query is translated to English for knowledge-base retrieval, and the English
 * answer is translated back to the user's selected language for output.
 *
 * Reaches the same Python service as TTS/STT (`TRANSLATE_SERVICE_URL`, then
 * `STT_SERVICE_URL`, then `TTS_SERVICE_URL`, else the local default). Never
 * throws — on any failure it returns the original text with `translated: false`.
 */

const TRANSLATE_TIMEOUT_MS = Number(process.env.TRANSLATE_TIMEOUT_MS ?? 8000)

function normalizeBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

function serviceUrl(): string {
  const raw =
    process.env.TRANSLATE_SERVICE_URL?.trim() ||
    process.env.STT_SERVICE_URL?.trim() ||
    process.env.TTS_SERVICE_URL?.trim()
  return normalizeBase(raw || 'http://127.0.0.1:8081')
}

export interface TranslateResult {
  text: string
  translated: boolean
  warning?: string | null
}

/**
 * Translate `text` from `source` to `target` (app codes: 'en'|'ig'|'yo'|'ha',
 * or 'auto' to detect). No-ops when text is empty or source === target.
 */
export async function translateText(
  text: string,
  source: string,
  target: string,
): Promise<TranslateResult> {
  const clean = (text || '').trim()
  if (!clean || source === target) return { text: clean, translated: false }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS)
  try {
    const res = await fetch(`${serviceUrl()}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, source, target }),
      signal: controller.signal,
    })
    if (!res.ok) return { text: clean, translated: false, warning: `translate service ${res.status}` }
    const data = (await res.json()) as Partial<TranslateResult>
    return { text: data.text?.trim() || clean, translated: !!data.translated, warning: data.warning ?? null }
  } catch (err) {
    return { text: clean, translated: false, warning: `translate unreachable: ${(err as Error).message}` }
  } finally {
    clearTimeout(timer)
  }
}
