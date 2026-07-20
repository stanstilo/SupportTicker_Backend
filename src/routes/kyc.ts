import type { FastifyInstance } from 'fastify'
import { KycUnavailable, isKycConfigured, verifyFace } from '../kyc'

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
}
