import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

/**
 * Server-side verification of Firebase ID tokens — the trust anchor for the
 * "hybrid bridge" auth model. The client signs in with Firebase (Google, email
 * link, phone, …), sends us the resulting ID token, and we verify it here
 * against Google's public keys before minting our own app JWT. No Firebase
 * Admin SDK or service-account key is required: Firebase ID tokens are standard
 * RS256 JWTs whose signing keys are published as a JWK set.
 *
 * Required env:
 *   FIREBASE_PROJECT_ID   your Firebase project id (audience + issuer check)
 */

// Google's public JWK set for Firebase Secure Token service. jose caches and
// refreshes these automatically (respecting cache-control), so we build it once.
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
)

export interface FirebaseIdentity {
  uid: string
  email?: string
  emailVerified: boolean
  name?: string
  picture?: string
  phoneNumber?: string
  /** e.g. "google.com", "password", "phone", "emailLink". */
  provider: string
}

export function firebaseProjectId(): string | null {
  return process.env.FIREBASE_PROJECT_ID?.trim() || null
}

export function isFirebaseConfigured(): boolean {
  return firebaseProjectId() !== null
}

interface FirebasePayload extends JWTPayload {
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
  phone_number?: string
  firebase?: { sign_in_provider?: string }
}

/**
 * Verify a Firebase ID token and return the caller's identity. Throws if the
 * token is missing/expired/forged or issued for a different project.
 */
export async function verifyFirebaseToken(idToken: string): Promise<FirebaseIdentity> {
  const projectId = firebaseProjectId()
  if (!projectId) throw new Error('Firebase is not configured (set FIREBASE_PROJECT_ID).')

  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
    algorithms: ['RS256'],
  })
  const p = payload as FirebasePayload
  if (!p.sub) throw new Error('Token has no subject.')

  return {
    uid: p.sub,
    email: p.email?.toLowerCase(),
    emailVerified: !!p.email_verified,
    name: p.name,
    picture: p.picture,
    phoneNumber: p.phone_number,
    provider: p.firebase?.sign_in_provider ?? 'firebase',
  }
}
