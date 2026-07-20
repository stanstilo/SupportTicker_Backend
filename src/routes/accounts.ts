import type { FastifyInstance } from 'fastify'
import { listAccounts, listContacts } from '../repo'
import { fetchAccounts, fetchContacts } from '../dataverse'

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate)

  // Dataverse is the primary CRM source; SQLite (seeded) is the fallback when
  // Dataverse is unconfigured, unreachable, or returns an error. fetch* returns
  // null when unconfigured (silent) and throws on a real failure (logged).
  app.get('/accounts', async () => {
    try {
      const live = await fetchAccounts()
      if (live) return live
    } catch (err) {
      app.log.warn(`Dataverse accounts unavailable, using SQLite fallback: ${(err as Error).message}`)
    }
    return listAccounts()
  })

  app.get('/contacts', async () => {
    try {
      const live = await fetchContacts()
      if (live) return live
    } catch (err) {
      app.log.warn(`Dataverse contacts unavailable, using SQLite fallback: ${(err as Error).message}`)
    }
    return listContacts()
  })
}
