/**
 * Live FX rates (base USD = 1) with multi-provider fallback and a short cache.
 *
 * Ported from FluentFlow's `get_usd_to_ngn_rate` (main.py): try each free
 * provider in order, keep the first good result, and fall back to a baked-in
 * table so conversions never break when every provider is down. Generalised
 * here from a single USD→NGN number to the full currency table the Service
 * Hub's FX tool offers.
 *
 * The cache keeps rates "current, not stale": a fresh table is fetched at most
 * once per RATES_TTL_MS (default 1h) instead of shipping hardcoded numbers.
 */

/** Currencies the FX tool offers (base USD = 1). */
export const RATE_SYMBOLS = ['USD', 'EUR', 'GBP', 'NGN', 'JPY', 'CAD', 'ZAR'] as const
export type CurrencyCode = (typeof RATE_SYMBOLS)[number]

/** Last-resort static table — mirrors the client's previous hardcoded rates. */
const FALLBACK_RATES: Record<CurrencyCode, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  NGN: 1580,
  JPY: 157,
  CAD: 1.36,
  ZAR: 18.3,
}

/** How long a fetched table stays fresh before we re-fetch. Default 1 hour. */
const TTL_MS = Number(process.env.RATES_TTL_MS ?? 60 * 60 * 1000)

export interface RatesResult {
  base: 'USD'
  rates: Record<string, number>
  /** ISO timestamp of when these rates were fetched (or last attempted). */
  fetchedAt: string
  /** URL the rates came from, or 'fallback' when the static table was used. */
  source: string
  /** True when serving cached-but-expired or the built-in fallback table. */
  stale: boolean
}

// Free, keyless, USD-base providers. All return the table under `.rates`. Order
// is priority: open.er-api.com first (most reliable), then two backups.
const PROVIDERS: readonly string[] = [
  'https://open.er-api.com/v6/latest/USD',
  'https://api.exchangerate-api.com/v4/latest/USD',
  `https://api.exchangerate.host/latest?base=USD&symbols=${RATE_SYMBOLS.join(',')}`,
]

let cache: RatesResult | null = null
let cacheAt = 0

async function fetchJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Pull the required symbols out of a provider's `.rates`; null if unusable. */
function normalise(data: unknown): Record<string, number> | null {
  const raw =
    data && typeof data === 'object' && 'rates' in data && typeof (data as { rates: unknown }).rates === 'object'
      ? ((data as { rates: Record<string, unknown> }).rates ?? {})
      : null
  if (!raw) return null

  const out: Record<string, number> = { USD: 1 }
  for (const code of RATE_SYMBOLS) {
    const value = Number(raw[code])
    if (Number.isFinite(value) && value > 0) out[code] = value
  }
  // Require NGN (the payments-critical pair) before trusting the table.
  return out.NGN > 0 ? out : null
}

/**
 * Current USD-base rates. Serves the in-memory cache while fresh; otherwise
 * walks the providers, then degrades to the last good cache, then the static
 * table — always returning something usable.
 */
export async function getRates(log?: (message: string) => void): Promise<RatesResult> {
  const now = Date.now()
  if (cache && now - cacheAt < TTL_MS) return cache

  for (const url of PROVIDERS) {
    try {
      const rates = normalise(await fetchJson(url))
      if (!rates) throw new Error('no usable rates in response')
      cache = { base: 'USD', rates, fetchedAt: new Date().toISOString(), source: url, stale: false }
      cacheAt = now
      log?.(`FX rates fetched from ${url}`)
      return cache
    } catch (err) {
      log?.(`FX rates provider failed (${url}): ${(err as Error).message}`)
    }
  }

  if (cache) {
    log?.('FX rates: all providers failed — serving last cached rates (stale)')
    return { ...cache, stale: true }
  }
  log?.('FX rates: all providers failed and no cache — using built-in fallback table')
  return {
    base: 'USD',
    rates: { ...FALLBACK_RATES },
    fetchedAt: new Date().toISOString(),
    source: 'fallback',
    stale: true,
  }
}
