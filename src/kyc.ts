/**
 * Server-side KYC face verification — the *authoritative* verifier.
 *
 * The real biometric/liveness service isn't wired yet, so this is a pluggable
 * adapter: pick a provider with the `KYC_PROVIDER` env var and implement its
 * function below. Until a provider is configured (or if one errors), the route
 * reports "unavailable" and the client falls back to its on-device face match.
 *
 * To add a provider later you only touch this file — the route and the frontend
 * contract stay the same.
 *
 *   KYC_PROVIDER = smileid | dojah | mock | (unset = disabled)
 */

/** Thrown when no provider is configured / a provider is a placeholder. Signals
 *  the caller to fall back rather than treat it as a hard verification failure. */
export class KycUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KycUnavailable'
  }
}

export interface FaceVerifyInput {
  /** ID/passport photo as a data URL or base64 string. */
  idImage: string
  /** Live selfie as a data URL or base64 string. */
  selfie: string
}

export interface FaceVerifyResult {
  passed: boolean
  /** 0..100 face-match confidence. */
  matchScore: number
  /** 0..100 liveness / anti-spoofing confidence. */
  livenessScore: number
  /** 0..100 combined. */
  overall: number
  /** Which provider produced this verdict. */
  provider: string
  reason?: string
}

export function kycProvider(): string | null {
  return process.env.KYC_PROVIDER?.trim().toLowerCase() || null
}

export function isKycConfigured(): boolean {
  return kycProvider() !== null
}

/**
 * Verify a selfie against an ID photo with the configured provider. Throws
 * `KycUnavailable` when no real provider is wired (→ client falls back); other
 * errors propagate so the route can report a transient service failure.
 */
export async function verifyFace(input: FaceVerifyInput): Promise<FaceVerifyResult> {
  const provider = kycProvider()
  if (!provider) throw new KycUnavailable('No KYC provider configured (set KYC_PROVIDER).')

  switch (provider) {
    case 'smileid':
      return verifyWithSmileId(input)
    case 'dojah':
      return verifyWithDojah(input)
    case 'mock':
      return verifyWithMock(input)
    default:
      throw new KycUnavailable(`Unknown KYC provider "${provider}".`)
  }
}

/* ----------------------------------------------------------- providers ---- */

/**
 * PLACEHOLDER — Smile ID (SmartSelfie™ / Enhanced KYC, good for NIN/BVN + liveness).
 * To implement:
 *   env: SMILEID_PARTNER_ID, SMILEID_API_KEY, SMILEID_ENV ('sandbox'|'production')
 *   1. Build the signature/auth per Smile ID docs.
 *   2. POST the id image + selfie (SmartSelfie job) to their API.
 *   3. Read ResultCode + confidence + liveness from the job result.
 *   4. Map → { passed, matchScore, livenessScore, overall, provider: 'smileid' }.
 */
async function verifyWithSmileId(_input: FaceVerifyInput): Promise<FaceVerifyResult> {
  throw new KycUnavailable('Smile ID adapter is a placeholder — not implemented yet.')
}

/**
 * PLACEHOLDER — Dojah (KYC + liveness + NIN/BVN lookup).
 * To implement:
 *   env: DOJAH_APP_ID, DOJAH_API_KEY, DOJAH_BASE_URL
 *   POST selfie + id image to the liveness/selfie-verification endpoint, map the
 *   confidence + liveness_check → FaceVerifyResult (provider: 'dojah').
 */
async function verifyWithDojah(_input: FaceVerifyInput): Promise<FaceVerifyResult> {
  throw new KycUnavailable('Dojah adapter is a placeholder — not implemented yet.')
}

/**
 * TEST-ONLY provider — proves the server verification path end-to-end without a
 * real service. Enable with KYC_PROVIDER=mock. It does NOT actually compare
 * faces; it just returns a pass. Never use in production.
 */
async function verifyWithMock(input: FaceVerifyInput): Promise<FaceVerifyResult> {
  const ok = !!input.idImage && !!input.selfie
  return {
    passed: ok,
    matchScore: ok ? 92 : 0,
    livenessScore: ok ? 95 : 0,
    overall: ok ? 93 : 0,
    provider: 'mock',
    reason: ok ? undefined : 'Missing image(s).',
  }
}
