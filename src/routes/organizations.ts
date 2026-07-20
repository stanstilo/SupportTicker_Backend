import type { FastifyInstance } from 'fastify'
import {
  countOrganizations,
  createOrganization,
  deleteOrganization,
  findOrganizationByDomain,
  getOrganization,
  listOrganizations,
  primaryOrganization,
  setPrimaryOrganization,
  updateOrganization,
} from '../repo'
import { requireRole } from '../auth'

const cleanDomain = (d: string) => d.trim().toLowerCase().replace(/^@/, '')
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

/**
 * Organization ownership. Reading is open to any signed-in user (the app brands
 * itself from the primary org); creating/changing/replacing the owning org is
 * restricted to super admins. Requests map to an org by email domain.
 */
export async function organizationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate)

  // The owning org — used for branding. Any authenticated user may read it.
  app.get('/primary', async () => primaryOrganization() ?? null)
  app.get('/', async () => listOrganizations())

  // Everything below changes ownership → super admins only.
  app.post<{ Body: { name?: string; domain?: string; makePrimary?: boolean } }>(
    '/',
    { preHandler: [requireRole('superadmin')] },
    async (req, reply) => {
      const name = req.body?.name?.trim()
      const domain = req.body?.domain ? cleanDomain(req.body.domain) : ''
      if (!name || !domain) return reply.code(400).send({ error: 'name and domain are required.' })
      if (!DOMAIN_RE.test(domain)) return reply.code(400).send({ error: 'Enter a valid domain, e.g. gifsonservices or ibtc.com.' })
      if (findOrganizationByDomain(domain)) return reply.code(409).send({ error: 'An organization with that domain already exists.' })
      return reply.code(201).send(createOrganization({ name, domain, makePrimary: req.body?.makePrimary }))
    },
  )

  app.patch<{ Params: { id: string }; Body: { name?: string; domain?: string } }>(
    '/:id',
    { preHandler: [requireRole('superadmin')] },
    async (req, reply) => {
      if (!getOrganization(req.params.id)) return reply.code(404).send({ error: 'Organization not found.' })
      const domain = req.body?.domain ? cleanDomain(req.body.domain) : undefined
      if (domain !== undefined) {
        if (!DOMAIN_RE.test(domain)) return reply.code(400).send({ error: 'Enter a valid domain.' })
        const clash = findOrganizationByDomain(domain)
        if (clash && clash.id !== req.params.id) return reply.code(409).send({ error: 'Another organization already uses that domain.' })
      }
      return updateOrganization(req.params.id, { name: req.body?.name, domain })
    },
  )

  // Change the owning organization (e.g. switch from gifsonservices to ibtc).
  app.post<{ Params: { id: string } }>(
    '/:id/primary',
    { preHandler: [requireRole('superadmin')] },
    async (req, reply) => {
      const updated = setPrimaryOrganization(req.params.id)
      if (!updated) return reply.code(404).send({ error: 'Organization not found.' })
      app.log.info(`Org ownership → primary is now "${updated.name}" (@${updated.domain})`)
      return updated
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [requireRole('superadmin')] },
    async (req, reply) => {
      const org = getOrganization(req.params.id)
      if (!org) return reply.code(404).send({ error: 'Organization not found.' })
      if (org.isPrimary) return reply.code(409).send({ error: 'Can’t delete the primary organization. Make another one primary first.' })
      if (countOrganizations() <= 1) return reply.code(409).send({ error: 'At least one organization is required.' })
      deleteOrganization(req.params.id)
      return reply.code(204).send()
    },
  )
}
