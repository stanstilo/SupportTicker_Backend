import type { FastifyInstance } from 'fastify'
import {
  countUsersByRole,
  deleteUser,
  getUserSummary,
  listAssignable,
  listUsers,
  setUserDepartment,
  setUserRole,
} from '../repo'
import { requireRole } from '../auth'
import { SERVICE_LINES, USER_ROLES, type ServiceLine, type UserRole } from '../types'

/**
 * User & role administration (RBAC). Reading the roster is open to admins and
 * super admins; *changing* a role is restricted to super admins — that's how
 * admin access is granted. Guards prevent locking the org out of super-admin.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', app.authenticate)

  // List users — admins and super admins.
  app.get('/', { preHandler: [requireRole('superadmin', 'admin')] }, async () => listUsers())

  // Members of a service department — the assignable pool for a request in that
  // service line. Open to any authenticated user: admins assign, and an assignee
  // hands off to a department peer. Returns names only (no roles/PII beyond email).
  app.get<{ Querystring: { serviceLine?: string } }>('/assignable', async (req, reply) => {
    const sl = req.query?.serviceLine
    if (!sl || !SERVICE_LINES.includes(sl as ServiceLine)) {
      return reply.code(400).send({ error: 'A valid serviceLine query is required.' })
    }
    return listAssignable(sl as ServiceLine)
  })

  // Set (or clear) a user's service department — admins and super admins.
  app.patch<{ Params: { id: string }; Body: { department?: string | null } }>(
    '/:id/department',
    { preHandler: [requireRole('superadmin', 'admin')] },
    async (req, reply) => {
      const dept = req.body?.department
      if (dept != null && !SERVICE_LINES.includes(dept as ServiceLine)) {
        return reply.code(400).send({ error: 'Unknown service department.' })
      }
      if (!getUserSummary(req.params.id)) return reply.code(404).send({ error: 'User not found.' })
      const updated = setUserDepartment(req.params.id, (dept as ServiceLine) ?? null)
      app.log.info(`RBAC: ${req.user.email} set ${req.params.id} department → ${dept ?? 'none'}`)
      return updated
    },
  )

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

  // Remove a user — super admins only. Ticket history survives (attribution is
  // free-text). Guards mirror the role endpoint: never orphan the org or self.
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [requireRole('superadmin')] },
    async (req, reply) => {
      const target = getUserSummary(req.params.id)
      if (!target) return reply.code(404).send({ error: 'User not found.' })
      if (req.params.id === req.user.sub) {
        return reply.code(409).send({ error: 'You can’t remove your own account.' })
      }
      // Never delete the last super admin (org lock-out safety).
      if (target.role === 'superadmin' && countUsersByRole('superadmin') <= 1) {
        return reply.code(409).send({ error: 'You can’t remove the last super admin. Promote another user first.' })
      }
      deleteUser(req.params.id)
      app.log.info(`RBAC: ${req.user.email} removed ${target.email}`)
      return reply.code(204).send()
    },
  )
}
