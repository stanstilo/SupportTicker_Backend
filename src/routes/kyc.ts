import type { FastifyInstance } from 'fastify'
import {
  KycUnavailable,
  isIdentityProviderConfigured,
  isKycConfigured,
  verifyBvn,
  verifyFace,
  verifyIdLiveness,
  verifyNin,
  verifyPassportDocument,
  verifySupportingDocument,
} from '../kyc'

/**
 * KYC face verification. Always responds 200 with an envelope so the client can
 * cleanly decide whether to trust the server verdict or fall back to on-device:
 *   { available: true,  result: {...} }  → authoritative server verdict
 *   { available: false, reason }         → no provider / placeholder / error → client falls back
 */
export async function kycRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate)

  app.post<{ Body: { idImage?: string; selfie?: string } }>('/verify-face', async (req, reply) => {
    const { idImage, selfie } = req.body ?? {}
    if (!idImage || !selfie) {
      return reply.code(400).send({ error: 'idImage and selfie are required.' })
    }

    // Fast path: no provider wired → tell the client to verify on-device.
    if (!isKycConfigured()) {
      return reply.send({ available: false, reason: 'No KYC provider configured on the server.' })
    }

    try {
      const result = await verifyFace({ idImage, selfie })
      return reply.send({ available: true, result })
    } catch (err) {
      if (err instanceof KycUnavailable) {
        // Provider is a placeholder / not ready — fall back, don't fail the user.
        return reply.send({ available: false, reason: err.message })
      }
      // A configured provider genuinely errored — log and let the client fall back.
      app.log.warn(`KYC provider error: ${(err as Error).message}`)
      return reply.send({ available: false, reason: 'Verification service temporarily unavailable.' })
    }
  })

  // Full identity proofing: upload an ID + a live selfie. Scans the ID for all
  // its fields and photo, runs a liveness check on the selfie, and compares the
  // ID photo to the live face — confirming the person holding the ID is the same
  // real, live person. Envelope mirrors /verify-face:
  //   { available: true,  result: {...} }  → server verdict (fields/liveness/match)
  //   { available: false, reason }          → no identity provider → client falls back
  app.post<{ Body: { idImage?: string; selfie?: string; allowSelfieOnly?: boolean } }>(
    '/verify-id-liveness',
    async (req, reply) => {
      const { idImage, selfie, allowSelfieOnly } = req.body ?? {}
      // A live selfie is always required. The ID image is required for the normal
      // (high-assurance) path, but may be omitted for the consented selfie-only
      // fallback — verifyIdLiveness enforces the document-first rule internally.
      if (!selfie) {
        return reply.code(400).send({ error: 'selfie is required.' })
      }
      if (!idImage && !allowSelfieOnly) {
        return reply.code(400).send({ error: 'idImage is required (or set allowSelfieOnly for the consented selfie-only fallback).' })
      }
      if (!isIdentityProviderConfigured()) {
        return reply.send({ available: false, reason: 'No identity provider (Dojah) configured on the server.' })
      }

      const result = await verifyIdLiveness({ idImage, selfie, allowSelfieOnly: allowSelfieOnly === true })
      return reply.send({ available: true, result })
    },
  )

  app.post<{ Body: { bvn?: string; name?: string; dob?: string } }>('/verify-bvn', async (req, reply) => {
    const { bvn, name, dob } = req.body ?? {}
    if (!bvn) {
      return reply.code(400).send({ error: 'bvn is required.' })
    }

    const result = await verifyBvn(bvn, { name, dob })
    return reply.send({ available: true, result })
  })

  app.post<{ Body: { nin?: string; name?: string; dob?: string } }>('/verify-nin', async (req, reply) => {
    const { nin, name, dob } = req.body ?? {}
    if (!nin) {
      return reply.code(400).send({ error: 'nin is required.' })
    }

    const result = await verifyNin(nin, { name, dob })
    return reply.send({ available: true, result })
  })

  app.post<{ Body: { documentType?: string; fileName?: string; mimeType?: string; imageBase64?: string } }>(
    '/verify-passport-document',
    async (req, reply) => {
      const { documentType, fileName, mimeType, imageBase64 } = req.body ?? {}
      if (!documentType || !fileName) {
        return reply.code(400).send({ error: 'documentType and fileName are required.' })
      }

      const result = await verifyPassportDocument({ documentType, fileName, mimeType, imageBase64 })
      return reply.send({ available: true, result })
    },
  )

  app.post<{ Body: { documentType?: string; fileName?: string; mimeType?: string; imageBase64?: string } }>(
    '/verify-supporting-document',
    async (req, reply) => {
      const { documentType, fileName, mimeType, imageBase64 } = req.body ?? {}
      if (!documentType || !fileName) {
        return reply.code(400).send({ error: 'documentType and fileName are required.' })
      }

      const result = await verifySupportingDocument({ documentType, fileName, mimeType, imageBase64 })
      return reply.send({ available: true, result })
    },
  )
}
