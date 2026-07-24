import type { FastifyInstance } from 'fastify'
import { getRates } from '../rates'

export async function rateRoutes(app: FastifyInstance): Promise<void> {
  // Public, non-sensitive market data — intentionally no auth hook so the FX
  // converter always resolves current rates, mirroring FluentFlow's rate fetch.
  app.get('/rates', async () => getRates((m) => app.log.info(m)))
}
