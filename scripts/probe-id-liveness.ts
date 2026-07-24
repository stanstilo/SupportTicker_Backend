/**
 * Probe the document-authenticity-first identity flow (verifyIdLiveness).
 *
 * Uses the Dojah sandbox test BVN photo as a stand-in for the ID image and the
 * selfie. That photo is a bare FACE (not a real ID doc) and a STILL image, so:
 *   • document authenticity fails (not a scannable ID)  → document_invalid/unreadable
 *   • with consent (allowSelfieOnly) the selfie-only path runs liveness, which
 *     correctly flags the still image as a spoof            → liveness_failed
 * Both prove the decision tree. A real, valid ID + a genuine live selfie flips
 * the outcome to `verified` (high assurance).
 *
 * Run: npx tsx scripts/probe-id-liveness.ts
 */
import { verifyIdLiveness } from '../src/kyc'

try {
  process.loadEnvFile()
} catch {
  /* no .env */
}

const appId = process.env.DOJAH_APP_ID?.trim() || ''
const apiKey = process.env.DOJAH_API_KEY?.trim() || ''
const baseUrl = (process.env.DOJAH_BASE_URL?.trim() || 'https://api.dojah.io').replace(/\/+$/, '')

async function testPhoto(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/kyc/bvn/full?bvn=22222222222`, {
    headers: { Authorization: apiKey, AppId: appId, Accept: 'application/json' },
  })
  const data = (await res.json()) as { entity?: { image?: string } }
  const img = data.entity?.image
  if (!img) throw new Error('Could not fetch a test face photo from the sandbox BVN record.')
  return img
}

function summarize(label: string, r: Awaited<ReturnType<typeof verifyIdLiveness>>): void {
  console.log(`\n=== ${label} ===`)
  console.log({
    passed: r.passed,
    status: r.status,
    assurance: r.assurance,
    nextAction: r.nextAction,
    selfieOnlyAvailable: r.selfieOnlyAvailable,
    reason: r.reason,
    document: {
      checked: r.document.checked,
      readable: r.document.readable,
      authentic: r.document.authentic,
      status: r.document.status,
      type: r.document.type,
      fieldCount: Object.keys(r.document.fields).length,
      photo: r.document.photo ? `<base64 ${r.document.photo.length}>` : null,
    },
    liveness: r.liveness,
    faceMatch: r.faceMatch,
  })
}

async function main(): Promise<void> {
  console.log('Base URL:', baseUrl, '| App ID set:', !!appId, '| key set:', !!apiKey)
  const photo = await testPhoto()
  console.log(`Test photo obtained (${photo.length} base64 chars).`)

  // 1. ID present but not authentic, no consent → should ask to re-upload.
  summarize('ID + selfie (no consent)', await verifyIdLiveness({ idImage: photo, selfie: photo }))

  // 2. Same, but user consents to selfie-only → liveness runs (still photo → spoof).
  summarize('selfie-only (consented)', await verifyIdLiveness({ idImage: photo, selfie: photo, allowSelfieOnly: true }))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
