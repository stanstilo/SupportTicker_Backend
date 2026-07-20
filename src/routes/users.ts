import type { FastifyInstance } from 'fastify'
import { countUsersByRole, getUserSummary, listUsers, setUserRole } from '../repo'
import { requireRole } from '../auth'
import { USER_ROLES, type UserRole } from '../types'

/**
 * User & role administration (RBAC). Reading the roster is open to admins and
 * super admins; *changing* a role is restricted to super admins — that's how
 * admin access is granted. Guards prevent locking the org out of super-admin.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate)

  // List users — admins and super admins.
  app.get('/', { preHandler: [requireRole('superadmin', 'admin')] }, async () => listUsers())

  // Assign a role — super admins only.
  app.patch<{ Params: { id: string }; Body: { role?: string } }>(
    '/:id/role',
    { preHandler: [requireRole('superadmin')] },
    async (req, reply) => {
      const role = req.body?.role as UserRole | undefined
      if (!role || !USER_ROLES.includes(role)) {
        return reply.code(400).send({ error: `Role must be one of: ${USER_ROLES.join(', ')}.` })
      }
      const target = getUserSummary(req.params.id)
      if (!target) return reply.code(404).send({ error: 'User not found.' })
      if (target.role === role) return target // no-op

      // Never allow removing the last super admin (org lock-out safety).
      if (target.role === 'superadmin' && role !== 'superadmin' && countUsersByRole('superadmin') <= 1) {
        return reply.code(409).send({ error: 'You can’t remove the last super admin. Promote another user first.' })
      }

      const updated = setUserRole(req.params.id, role)
      if (!updated) return reply.code(404).send({ error: 'User not found.' })
      app.log.info(`RBAC: ${req.user.email} set ${updated.email} → ${role}`)
      return updated
    },
  )
}
