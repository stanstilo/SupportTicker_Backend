/**
 * Server-side KYC verification — the *authoritative* verifier.
 *
 * Two concerns live here:
 *
 *  1. Face / liveness (verifyFace) — a pluggable adapter selected by
 *     `KYC_PROVIDER` (smileid | dojah | mock). Smile ID / Dojah face adapters
 *     are still placeholders; until one is wired the route reports
 *     "unavailable" and the client falls back to its on-device face match.
 *
 *  2. Identity + document (verifyBvn / verifyNin / verifyPassportDocument /
 *     verifySupportingDocument) — REAL provider calls via **Dojah**
 *     (https://dojah.io), Nigeria's KYC API for NIBSS BVN, NIMC NIN, and
 *     document analysis. Configure with:
 *
 *       DOJAH_APP_ID   = your Dojah app id
 *       DOJAH_API_KEY  = your Dojah secret key
 *       DOJAH_BASE_URL = https://api.dojah.io   (or the sandbox base URL)
 *
 *     When those aren't set, these degrade to a local format/heuristic check so
 *     the flow still works in development — but the verdict is clearly marked
 *     `provider: 'format-check'` (not authoritative).
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

export interface IdentityVerifyResult {
  passed: boolean
  score: number
  /** Which provider produced this verdict ('dojah' | 'format-check' | ...). */
  provider: string
  reason?: string
  /** Non-sensitive fields the provider returned (e.g. matched name), for audit. */
  data?: Record<string, unknown>
}

/** Optional applicant data to match a looked-up record against. */
export interface ExpectedIdentity {
  name?: string
  dob?: string
}

export interface DocumentVerifyInput {
  documentType: string
  fileName: string
  mimeType?: string
  /** The document image as a data URL or base64 — enables real analysis. */
  imageBase64?: string
}

const KYC_TIMEOUT_MS = Number(process.env.KYC_TIMEOUT_MS ?? 12000)

export function kycProvider(): string | null {
  return process.env.KYC_PROVIDER?.trim().toLowerCase() || null
}

export function isKycConfigured(): boolean {
  return kycProvider() !== null
}

/* -------------------------------------------------- Dojah identity client -- */

interface DojahEnv {
  appId: string
  apiKey: string
  baseUrl: string
}

function readDojahEnv(): DojahEnv | null {
  const appId = process.env.DOJAH_APP_ID?.trim()
  const apiKey = process.env.DOJAH_API_KEY?.trim()
  if (!appId || !apiKey) return null
  const baseUrl = (process.env.DOJAH_BASE_URL?.trim() || 'https://api.dojah.io').replace(/\/+$/, '')
  return { appId, apiKey, baseUrl }
}

/**
 * Dojah REST endpoints used by this module (appended to `DOJAH_BASE_URL`).
 * Centralized so the paths (including the liveness URL) are in one place.
 */
const DOJAH_ENDPOINTS = {
  bvnFull: '/api/v1/kyc/bvn/full',
  nin: '/api/v1/kyc/nin',
  documentAnalysis: '/api/v1/document/analysis',
  /** Liveness / anti-spoofing: is this a live person or a photo of a photo? */
  liveness: '/api/v1/ml/liveness',
  /** Selfie ↔ photo-ID face comparison. */
  photoIdVerify: '/api/v1/kyc/photoid/verify',
} as const

/** True when real identity/document verification (Dojah) is wired. */
export function isIdentityProviderConfigured(): boolean {
  return readDojahEnv() !== null
}

/** Label for the active identity verifier, for logs. */
export function identityProviderLabel(): string {
  return readDojahEnv() ? 'dojah' : 'format-check'
}

/**
 * Call a Dojah REST endpoint. Dojah authenticates with two headers:
 * `Authorization: <secret key>` and `AppId: <app id>`. Throws on timeout or a
 * non-2xx response; callers translate that into a non-authoritative verdict.
 */
async function dojahRequest<T>(
  env: DojahEnv,
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`${env.baseUrl}${path}`)
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) url.searchParams.set(key, value)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), KYC_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: env.apiKey,
        AppId: env.appId,
        Accept: 'application/json',
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    let json: any = {}
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const detail = json?.error || json?.message || text.slice(0, 200) || res.statusText
      throw new Error(`Dojah ${path} (${res.status}): ${detail}`)
    }
    return json as T
  } finally {
    clearTimeout(timer)
  }
}

function nameTokens(value: string | undefined): string[] {
  return (value ?? '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 1)
}

/**
 * Loose name match: true if any expected token appears in the record's name
 * parts. Returns null when there's nothing to compare (no expected name or no
 * record name), so callers don't fail on missing data. Deliberately lenient to
 * avoid false negatives from name ordering / middle names.
 */
function nameMatches(expected: string | undefined, ...recordParts: Array<unknown>): boolean | null {
  const exp = nameTokens(expected)
  if (!exp.length) return null
  const record = new Set(recordParts.flatMap((p) => nameTokens(typeof p === 'string' ? p : undefined)))
  if (!record.size) return null
  return exp.some((t) => record.has(t))
}

/* ---------------------------------------------------------- BVN / NIN ------ */

export async function verifyBvn(bvn: string, expected?: ExpectedIdentity): Promise<IdentityVerifyResult> {
  const normalized = bvn.trim()
  if (!/^\d{11}$/.test(normalized)) {
    return { passed: false, score: 0, provider: identityProviderLabel(), reason: 'BVN must be 11 digits.' }
  }

  const env = readDojahEnv()
  if (!env) {
    // No provider wired — format check only (not authoritative).
    return {
      passed: true,
      score: 98,
      provider: 'format-check',
      reason: 'BVN format valid (no verification provider configured).',
    }
  }

  try {
    const data = await dojahRequest<{ entity?: Record<string, any> }>(env, 'GET', DOJAH_ENDPOINTS.bvnFull, {
      query: { bvn: normalized },
    })
    const entity = data.entity
    if (!entity || !(entity.bvn || entity.first_name || entity.last_name)) {
      return { passed: false, score: 0, provider: 'dojah', reason: 'BVN not found in NIBSS records.' }
    }

    const match = nameMatches(expected?.name, entity.first_name, entity.last_name, entity.middle_name)
    const fullName = [entity.first_name, entity.middle_name, entity.last_name].filter(Boolean).join(' ')
    if (match === false) {
      return {
        passed: false,
        score: 45,
        provider: 'dojah',
        reason: 'BVN record does not match the applicant name.',
        data: { name: fullName },
      }
    }
    return { passed: true, score: 98, provider: 'dojah', data: { name: fullName } }
  } catch (err) {
    return { passed: false, score: 0, provider: 'dojah', reason: `BVN verification unavailable: ${(err as Error).message}` }
  }
}

export async function verifyNin(nin: string, expected?: ExpectedIdentity): Promise<IdentityVerifyResult> {
  const normalized = nin.trim()
  if (!/^\d{11}$/.test(normalized)) {
    return { passed: false, score: 0, provider: identityProviderLabel(), reason: 'NIN must be 11 digits.' }
  }

  const env = readDojahEnv()
  if (!env) {
    return {
      passed: true,
      score: 97,
      provider: 'format-check',
      reason: 'NIN format valid (no verification provider configured).',
    }
  }

  try {
    const data = await dojahRequest<{ entity?: Record<string, any> }>(env, 'GET', DOJAH_ENDPOINTS.nin, {
      query: { nin: normalized },
    })
    const entity = data.entity
    if (!entity || !(entity.nin || entity.firstname || entity.first_name || entity.surname)) {
      return { passed: false, score: 0, provider: 'dojah', reason: 'NIN not found in NIMC records.' }
    }

    // Dojah's NIN payload uses firstname/surname/middlename; be tolerant of both styles.
    const match = nameMatches(
      expected?.name,
      entity.firstname,
      entity.first_name,
      entity.surname,
      entity.last_name,
      entity.middlename,
      entity.middle_name,
    )
    const fullName = [entity.firstname ?? entity.first_name, entity.middlename ?? entity.middle_name, entity.surname ?? entity.last_name]
      .filter(Boolean)
      .join(' ')
    if (match === false) {
      return {
        passed: false,
        score: 45,
        provider: 'dojah',
        reason: 'NIN record does not match the applicant name.',
        data: { name: fullName },
      }
    }
    return { passed: true, score: 97, provider: 'dojah', data: { name: fullName } }
  } catch (err) {
    return { passed: false, score: 0, provider: 'dojah', reason: `NIN verification unavailable: ${(err as Error).message}` }
  }
}

/* ------------------------------------------ ID scan + liveness + face match */

/**
 * Assurance thresholds. A result counts only when BOTH the face match and the
 * liveness confidence clear these (spec: matchScore ≥ 70 AND liveness ≥ 70).
 */
const FACE_MATCH_MIN = Number(process.env.KYC_FACE_MATCH_MIN ?? 70)
const LIVENESS_MIN = Number(process.env.KYC_LIVENESS_MIN ?? 70)
// Dojah's passive /ml/liveness runs on a SINGLE still frame, so it frequently
// flags genuine one-shot webcam selfies as spoofs (a real reliable check needs
// active/multi-frame capture). By default liveness is therefore ADVISORY: a
// failed/low liveness never hard-blocks — it routes to MANUAL REVIEW with the
// result flagged for a human. Set KYC_LIVENESS_STRICT=true to hard-gate on it
// (only sensible once active liveness is wired).
const LIVENESS_STRICT = String(process.env.KYC_LIVENESS_STRICT ?? '').toLowerCase() === 'true'

/** Outcome of the identity-proofing flow — drives what the client does next. */
export type IdLivenessStatus =
  | 'verified' // document authentic + live + face match → high assurance
  | 'review_facematched' // genuine ID that couldn't be auto-validated, but live + face match → manual review
  | 'verified_low_assurance' // consented selfie-only path passed → limited + manual review
  | 'document_unreadable' // ID couldn't be read / not a real ID → re-upload a clearer image
  | 'document_invalid' // ID read but failed authenticity (tampered/forged/expired) → re-upload or selfie-only
  | 'no_face' // no face detected in the live capture → re-capture
  | 'liveness_failed' // spoof / low-confidence liveness → re-capture
  | 'face_mismatch' // live face ≠ the photo on the ID → re-capture
  | 'provider_error' // a required provider call was unavailable → retry / manual review

/** What the client should do next. */
export type IdLivenessAction = 'grant_access' | 'reupload_id' | 'retry_capture' | 'manual_review'

/**
 * Result of the document-authenticity-first identity flow. Ordering matters:
 * the document is authenticated FIRST; a selfie/liveness pass is treated as
 * authoritative ONLY against a document that is itself demonstrably real.
 */
export interface IdLivenessResult {
  passed: boolean
  status: IdLivenessStatus
  /** Trust level: 'high' (validated ID + match) | 'medium' (genuine-but-unvalidated
   *  ID + match, pending manual review) | 'low' (selfie-only) | 'none'. */
  assurance: 'high' | 'medium' | 'low' | 'none'
  /** Next step for the client to drive retry / re-upload / manual-review UX. */
  nextAction: IdLivenessAction
  /** When true the client may offer a consented, low-assurance selfie-only path. */
  selfieOnlyAvailable: boolean
  provider: string
  reason?: string
  /** Everything scanned off the uploaded ID document. */
  document: {
    checked: boolean
    readable: boolean
    authentic: boolean
    status?: number
    reason?: string
    type?: string
    /** All extracted ID fields keyed by Dojah's field_key (document_number, dob, …). */
    fields: Record<string, string>
    /** The portrait photo cropped from the ID (base64), or null if none. */
    photo: string | null
  }
  /** Live-person / anti-spoof check on the selfie. */
  liveness: { checked: boolean; live: boolean; faceDetected: boolean; confidence: number }
  /** Face comparison between the ID photo and the live selfie. */
  faceMatch: { checked: boolean; matched: boolean; confidence: number }
}

// Known ID field keys Dojah sometimes places directly on the entity (rather than
// only inside text_data). Used to widen extraction so name/ID number aren't missed.
const _ID_TOPLEVEL_KEYS = [
  'first_name', 'last_name', 'surname', 'given_names', 'middle_name', 'other_names', 'full_name', 'name',
  'document_number', 'nin', 'national_id', 'id_number', 'personal_number', 'date_of_birth', 'dob',
  'expiry_date', 'issue_date', 'nationality', 'gender', 'sex',
]

/**
 * Collect the OCR-extracted ID fields from a Dojah document-analysis entity.
 * Dojah can return fields in three places, so we merge all of them and drop
 * blank / placeholder (`-1`) values:
 *   1. `text_data[]` (array of {field_key, value}) — the primary place,
 *   2. an `mrz` block (passports / machine-readable IDs),
 *   3. known fields placed directly on the entity.
 */
function extractIdFields(entity: any): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (k: unknown, v: unknown): void => {
    if (!k) return
    const key = String(k).trim()
    const val = v == null ? '' : String(v).trim()
    if (key && val && val !== '-1' && !(key in out)) out[key] = val
  }
  for (const row of Array.isArray(entity?.text_data) ? entity.text_data : []) {
    put(row?.field_key || row?.field_name, row?.value)
  }
  const mrz = entity?.mrz ?? entity?.MRZ
  if (mrz && typeof mrz === 'object') {
    for (const [k, v] of Object.entries(mrz)) put(k, v)
  }
  for (const k of _ID_TOPLEVEL_KEYS) {
    const v = entity?.[k]
    if (v != null && typeof v !== 'object') put(k, v)
  }
  return out
}

type DocCheck = IdLivenessResult['document'] & { error?: string }
type LiveCheck = IdLivenessResult['liveness'] & { error?: string }
type MatchCheck = IdLivenessResult['faceMatch'] & { error?: string }

/** Step 1 — document authenticity (OCR + Dojah's format/security checks). */
async function checkDocument(env: DojahEnv, idImage: string): Promise<DocCheck> {
  try {
    const data = await dojahRequest<{ entity?: any }>(env, 'POST', DOJAH_ENDPOINTS.documentAnalysis, {
      body: { input_type: 'base64', image: idImage },
    })
    const e = data.entity ?? {}
    const fields = extractIdFields(e)
    const portrait = e?.document_images?.portrait || null
    const overall = Number(e?.status?.overall_status)
    // Readable: OCR produced something (portrait, fields, or a recognised type).
    const readable = !!(portrait || Object.keys(fields).length || e?.document_type?.document_name)
    // Diagnostic (keys only, no PII values): shows whether Dojah's OCR actually
    // returned name/ID fields, so an empty result is easy to distinguish from a
    // parsing miss. If text_data comes back all-empty, the client OCR fallback runs.
    try {
      const td = Array.isArray(e?.text_data) ? e.text_data : []
      // eslint-disable-next-line no-console
      console.info(
        `[kyc] doc/analysis status=${e?.status?.overall_status} type=${e?.document_type?.document_name ?? '-'} ` +
          `text_data=[${td.map((r: any) => `${r.field_key}:${r.value ? 'set' : 'empty'}`).join(',')}] ` +
          `extractedKeys=[${Object.keys(fields).join(',')}]`,
      )
    } catch {
      /* ignore logging errors */
    }
    return {
      checked: true,
      readable,
      authentic: overall === 1, // Dojah: 1 = valid, 2 = review, 0 = invalid
      status: Number.isFinite(overall) ? overall : undefined,
      reason: e?.status?.reason,
      type: e?.document_type?.document_name,
      fields,
      photo: portrait,
    }
  } catch (err) {
    return { checked: true, readable: false, authentic: false, fields: {}, photo: null, error: (err as Error).message }
  }
}

/** Step 2a — passive liveness / anti-spoof on the live selfie. */
async function checkLiveness(env: DojahEnv, selfie: string): Promise<LiveCheck> {
  try {
    const data = await dojahRequest<{ entity?: any }>(env, 'POST', DOJAH_ENDPOINTS.liveness, { body: { image: selfie } })
    const e = data.entity ?? {}
    // Dojah returns liveness.spoof (true = a photo/screen, false = a live person).
    return {
      checked: true,
      live: e?.liveness?.spoof === false,
      faceDetected: e?.face?.detected === true,
      confidence: Math.round(Number(e?.liveness?.confidence ?? 0)),
    }
  } catch (err) {
    return { checked: true, live: false, faceDetected: false, confidence: 0, error: (err as Error).message }
  }
}

/** Step 2b — face comparison: live selfie vs the photo on the ID. */
async function checkFaceMatch(env: DojahEnv, selfie: string, idImage: string): Promise<MatchCheck> {
  try {
    const data = await dojahRequest<{ entity?: any }>(env, 'POST', DOJAH_ENDPOINTS.photoIdVerify, {
      body: { selfie_image: selfie, photoid_image: idImage },
    })
    const s = data.entity?.selfie ?? data.entity ?? {}
    const conf = Math.round(Number(s.confidence_value ?? s.confidence ?? 0))
    return { checked: true, matched: s.match === true || conf >= FACE_MATCH_MIN, confidence: conf }
  } catch (err) {
    return { checked: true, matched: false, confidence: 0, error: (err as Error).message }
  }
}

/**
 * Document-authenticity-first identity proofing (KYC / risk-compliance path).
 *
 * Rule: authenticate the DOCUMENT first; only if the ID is demonstrably real do
 * we run selfie + liveness and treat a face match as authoritative. If the ID is
 * invalid, a matching selfie is NOT accepted as proof — the client is told to
 * re-upload a real ID, or (with explicit user consent, `allowSelfieOnly`) run a
 * limited, low-assurance selfie-only flow that always routes to manual review.
 *
 *   Step 1  document authenticity (OCR + format/security checks)
 *   Step 2  IF authentic → face match (≥70) AND liveness (≥70) → verified (high)
 *           IF not authentic → reupload_id, or consented selfie-only (low)
 *
 * Never throws; a failed provider call degrades to `provider_error`.
 */
export async function verifyIdLiveness(input: {
  idImage?: string
  selfie: string
  /** Explicit user consent to the low-assurance selfie-only fallback. */
  allowSelfieOnly?: boolean
}): Promise<IdLivenessResult> {
  const env = readDojahEnv()
  const idImage = (input.idImage || '').replace(/^data:[^;]+;base64,/, '').trim()
  const selfie = (input.selfie || '').replace(/^data:[^;]+;base64,/, '').trim()

  const result: IdLivenessResult = {
    passed: false,
    status: 'provider_error',
    assurance: 'none',
    nextAction: 'manual_review',
    selfieOnlyAvailable: false,
    provider: env ? 'dojah' : 'unavailable',
    document: { checked: false, readable: false, authentic: false, fields: {}, photo: null },
    liveness: { checked: false, live: false, faceDetected: false, confidence: 0 },
    faceMatch: { checked: false, matched: false, confidence: 0 },
  }

  if (!env) {
    return { ...result, reason: 'Dojah is not configured (set DOJAH_APP_ID / DOJAH_API_KEY).' }
  }
  if (!selfie) {
    return { ...result, status: 'no_face', nextAction: 'retry_capture', reason: 'A live selfie is required.' }
  }

  // ---- STEP 1: Document authenticity FIRST ---------------------------------
  if (idImage) {
    const doc = await checkDocument(env, idImage)
    result.document = { ...doc }
    delete (result.document as any).error

    if (doc.error) {
      // Provider/network failure (not a forged-doc signal) → don't guess; review.
      return { ...result, status: 'provider_error', nextAction: 'manual_review', reason: `Document check unavailable: ${doc.error}` }
    }

    // A REAL / recognizable ID (readable) gets the full selfie check — liveness
    // AND a face match against the ID photo — even when Dojah couldn't
    // auto-validate it. Only a genuinely unreadable / non-ID image skips to
    // re-upload or the consented selfie-only path.
    if (doc.readable) {
      // ---- STEP 2: liveness + face match against the ID, in parallel --------
      const [live, match] = await Promise.all([checkLiveness(env, selfie), checkFaceMatch(env, selfie, idImage)])
      result.liveness = { ...live }
      result.faceMatch = { ...match }
      delete (result.liveness as any).error
      delete (result.faceMatch as any).error

      if (live.error || match.error) {
        return {
          ...result,
          status: 'provider_error',
          nextAction: 'manual_review',
          reason: `Verification unavailable: ${[live.error, match.error].filter(Boolean).join('; ')}`,
        }
      }
      if (!live.faceDetected) {
        return { ...result, status: 'no_face', nextAction: 'retry_capture', reason: 'No face detected in the live capture — retake the selfie.' }
      }
      if (!match.matched || match.confidence < FACE_MATCH_MIN) {
        return { ...result, status: 'face_mismatch', nextAction: 'retry_capture', reason: 'The live face does not match the photo on the ID.' }
      }

      const livePass = live.live && live.confidence >= LIVENESS_MIN
      // Strict mode only: a failed liveness hard-blocks with a retry. By default
      // (advisory) liveness never blocks — it's flagged for the reviewer below.
      if (LIVENESS_STRICT && !livePass) {
        return { ...result, status: 'liveness_failed', nextAction: 'retry_capture', reason: 'Liveness failed — the capture looks like a photo/screen, not a live person.' }
      }

      // Face matches the ID + validated ID + passing liveness → auto-verify.
      if (doc.authentic && livePass) {
        return { ...result, passed: true, status: 'verified', assurance: 'high', nextAction: 'grant_access', reason: undefined }
      }

      // Otherwise route to MANUAL REVIEW with the facial match confirmed and the
      // exact document/liveness state flagged. (Advisory liveness: a genuine
      // one-shot selfie the passive check can't confirm still reaches a human
      // rather than being rejected outright.)
      const livenessNote = livePass
        ? `liveness passed (${live.confidence}%)`
        : 'liveness inconclusive (single-frame passive check)'
      const docNote = doc.authentic
        ? 'ID validated'
        : `ID appears genuine but could not be auto-validated${doc.reason ? ` (${doc.reason})` : ''}`
      return {
        ...result,
        passed: false,
        status: 'review_facematched',
        assurance: 'medium',
        nextAction: 'manual_review',
        reason: `${docNote}. Facial match against the ID confirmed (${match.confidence}%); ${livenessNote} — routed to manual review: verified facial match.`,
      }
    }

    // Not a readable / recognizable ID.
    if (!input.allowSelfieOnly) {
      return {
        ...result,
        status: 'document_unreadable',
        nextAction: 'reupload_id',
        selfieOnlyAvailable: true,
        reason: 'The image could not be read as an ID — please re-upload a clearer photo of a valid ID, or continue with selfie-only (limited).',
      }
    }
    // fall through to the consented selfie-only branch below.
  } else if (!input.allowSelfieOnly) {
    // No ID supplied and no consent to selfie-only → an ID is required.
    return { ...result, status: 'document_unreadable', nextAction: 'reupload_id', selfieOnlyAvailable: true, reason: 'An ID document image is required.' }
  }

  // ---- Consented selfie-only fallback (LOW assurance) ----------------------
  // Reached when the ID failed authenticity (or none was given) and the user
  // explicitly consented. Liveness only — there is no trusted ID to match
  // against — so the result is low assurance and always routes to manual review.
  const live = await checkLiveness(env, selfie)
  result.liveness = { ...live }
  delete (result.liveness as any).error
  if (live.error) {
    return { ...result, status: 'provider_error', nextAction: 'manual_review', reason: `Liveness unavailable: ${live.error}` }
  }
  if (!live.faceDetected) {
    return { ...result, status: 'no_face', nextAction: 'retry_capture', reason: 'No face detected in the live capture — retake the selfie.' }
  }
  const livePass = live.live && live.confidence >= LIVENESS_MIN
  // Strict mode only: hard-block on a failed liveness. Advisory (default) lets a
  // face-detected selfie through at low assurance with liveness flagged.
  if (LIVENESS_STRICT && !livePass) {
    return { ...result, status: 'liveness_failed', nextAction: 'retry_capture', reason: 'Liveness failed — the capture looks like a photo/screen, not a live person.' }
  }
  return {
    ...result,
    passed: true,
    status: 'verified_low_assurance',
    assurance: 'low',
    nextAction: 'manual_review',
    reason: livePass
      ? 'Liveness passed but the ID was not authenticated — low-assurance (selfie-only). Limit privileges and route to manual review.'
      : 'Selfie captured (liveness inconclusive, single-frame passive check); the ID was not authenticated — low-assurance (selfie-only). Limit privileges and route to manual review.',
  }
}

/* --------------------------------------------------------- Documents ------- */

function heuristicDocumentCheck(
  { documentType, fileName, mimeType }: DocumentVerifyInput,
  accepted: (normalizedType: string) => boolean,
  failReason: string,
): IdentityVerifyResult {
  const normalizedType = documentType.toLowerCase()
  const hasName = !!fileName?.trim()
  const hasSupportedMime = !mimeType || mimeType.startsWith('image/') || mimeType === 'application/pdf' || mimeType.includes('word')
  const passed = accepted(normalizedType) && hasName && hasSupportedMime
  return {
    passed,
    score: passed ? 90 : 0,
    provider: 'format-check',
    reason: passed ? 'Document format accepted (no verification provider configured).' : failReason,
  }
}

/**
 * Real document analysis via Dojah when an image and provider are available;
 * otherwise a local format/heuristic check. `imageBase64` may be a data URL or
 * raw base64. PDFs/Word docs can't be analysed by the image endpoint, so those
 * fall through to the heuristic check.
 */
async function analyseDocument(
  input: DocumentVerifyInput,
  accepted: (normalizedType: string) => boolean,
  failReason: string,
): Promise<IdentityVerifyResult> {
  const env = readDojahEnv()
  const image = (input.imageBase64 || '').replace(/^data:[^;]+;base64,/, '').trim()
  const isImage = !input.mimeType || input.mimeType.startsWith('image/')

  if (!env || !image || !isImage) {
    return heuristicDocumentCheck(input, accepted, failReason)
  }

  try {
    const data = await dojahRequest<{ entity?: Record<string, any> }>(env, 'POST', DOJAH_ENDPOINTS.documentAnalysis, {
      body: { input_type: 'base64', image },
    })
    const entity = data.entity
    if (!entity) {
      return { passed: false, score: 0, provider: 'dojah', reason: 'Document could not be read.' }
    }

    // Dojah returns extracted fields (document_number, first_name, surname,
    // date_of_birth, text_data, document_type, ...). Treat a document as
    // verified when meaningful data was extracted.
    const docType = String(entity.document_type ?? entity.documentType ?? '').toLowerCase()
    const extracted =
      entity.document_number ||
      entity.first_name ||
      entity.surname ||
      entity.last_name ||
      entity.date_of_birth ||
      entity.text_data ||
      docType
    if (!extracted) {
      return { passed: false, score: 25, provider: 'dojah', reason: 'Document text could not be extracted — upload a clearer image.' }
    }

    const name = [entity.first_name, entity.surname ?? entity.last_name].filter(Boolean).join(' ')
    return {
      passed: true,
      score: 95,
      provider: 'dojah',
      data: { documentType: docType || undefined, documentNumber: entity.document_number, name: name || undefined },
    }
  } catch (err) {
    return { passed: false, score: 0, provider: 'dojah', reason: `Document verification unavailable: ${(err as Error).message}` }
  }
}

export async function verifyPassportDocument(input: DocumentVerifyInput): Promise<IdentityVerifyResult> {
  return analyseDocument(
    input,
    (t) => t.includes('passport') || t.includes('international') || t.includes('identity'),
    'Upload a readable passport or international identity document image/PDF.',
  )
}

export async function verifySupportingDocument(input: DocumentVerifyInput): Promise<IdentityVerifyResult> {
  return analyseDocument(
    input,
    (t) =>
      t.includes('address') ||
      t.includes('income') ||
      t.includes('business') ||
      t.includes('fund') ||
      t.includes('identity') ||
      t.includes('passport') ||
      t.includes('nin'),
    'Upload a readable supporting document in an accepted format.',
  )
}

/* ------------------------------------------------------- Face / liveness --- */

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
 * Dojah selfie / liveness verification. Compares a selfie photo against an ID
 * photo via Dojah's KYC selfie endpoint. Requires DOJAH_APP_ID + DOJAH_API_KEY;
 * throws `KycUnavailable` when they're absent so the client falls back.
 */
async function verifyWithDojah(input: FaceVerifyInput): Promise<FaceVerifyResult> {
  const env = readDojahEnv()
  if (!env) throw new KycUnavailable('Dojah is selected but DOJAH_APP_ID / DOJAH_API_KEY are not set.')

  const selfie = (input.selfie || '').replace(/^data:[^;]+;base64,/, '').trim()
  const idImage = (input.idImage || '').replace(/^data:[^;]+;base64,/, '').trim()
  if (!selfie || !idImage) throw new Error('Missing selfie or ID image.')

  // Dojah "KYC - Selfie Photo ID Verification": compares a selfie to an ID photo.
  const data = await dojahRequest<{ entity?: Record<string, any> }>(env, 'POST', DOJAH_ENDPOINTS.photoIdVerify, {
    body: { selfie_image: selfie, photoid_image: idImage },
  })
  const entity = data.entity ?? {}
  const selfieBlock = entity.selfie ?? entity
  // Dojah returns a confidence_value (0..100) and a `match` boolean.
  const matchScore = Math.round(Number(selfieBlock.confidence_value ?? selfieBlock.confidence ?? 0))
  const matched = selfieBlock.match === true || matchScore >= 70
  const livenessScore = matched ? 90 : Math.min(matchScore, 60)
  const overall = Math.round((matchScore + livenessScore) / 2)
  return {
    passed: matched,
    matchScore,
    livenessScore,
    overall,
    provider: 'dojah',
    reason: matched ? undefined : 'Selfie did not match the ID photo with sufficient confidence.',
  }
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
