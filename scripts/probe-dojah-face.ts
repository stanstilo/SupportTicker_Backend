/**
 * Probe the Dojah selfie/photo-ID face endpoint to confirm the path + auth are
 * correct. Sends a tiny placeholder image (no real face), so a "face not
 * detected"/validation response is the EXPECTED success signal — it proves the
 * endpoint exists and our App ID + secret key authorize. A 404 would mean the
 * path is wrong; a 401 an auth problem.
 *
 * Run: npx tsx scripts/probe-dojah-face.ts
 */
try {
  process.loadEnvFile()
} catch {
  /* no .env */
}

const appId = process.env.DOJAH_APP_ID?.trim() || ''
const apiKey = process.env.DOJAH_API_KEY?.trim() || ''
const baseUrl = (process.env.DOJAH_BASE_URL?.trim() || 'https://api.dojah.io').replace(/\/+$/, '')

// 1x1 transparent PNG.
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const CANDIDATE_ENDPOINTS = ['/api/v1/kyc/photoid/verify']

async function probe(path: string): Promise<void> {
  const url = `${baseUrl}${path}`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        AppId: appId,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ selfie_image: TINY_PNG, photoid_image: TINY_PNG }),
    })
    const text = await res.text()
    console.log(`POST ${path} → HTTP ${res.status}`)
    console.log(text.slice(0, 600))
  } catch (err) {
    console.log(`POST ${path} → network error: ${(err as Error).message}`)
  }
  console.log('')
}

async function main(): Promise<void> {
  console.log('Base URL:', baseUrl, '| App ID set:', !!appId, '| key set:', !!apiKey, '\n')
  for (const path of CANDIDATE_ENDPOINTS) await probe(path)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
