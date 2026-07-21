import fastifyJwt from '@fastify/jwt'
import bcrypt from 'bcryptjs'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { UserRole } from './types'

export interface JwtUser {
  sub: string
  email: string
  name: string
  role: UserRole
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser
    user: JwtUser
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

const JWT_SECRET = process.env.JWT_SECRET ?? 'support-ticker-dev-secret-change-me-in-production'

/** Registers JWT support and an `authenticate` preHandler for guarded routes. */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  await app.register(fastifyJwt, { secret: JWT_SECRET })

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify()
    } catch {
      reply.code(401).send({ error: 'Authentication required.' })
    }
  })
}

/**
 * RBAC preHandler factory: allows the request only if the authenticated user's
 * role is one of `allowed`. Use after `authenticate` (it reads `req.user`).
 */
export function requireRole(...allowed: UserRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.user || !allowed.includes(req.user.role)) {
      reply.code(403).send({ error: 'You don’t have permission to do that.' })
    }
  }
}

export const hashPassword = (password: string): Promise<string> => bcrypt.hash(password, 10)
export const verifyPassword = (password: string, hash: string): Promise<boolean> =>
  bcrypt.compare(password, hash)
