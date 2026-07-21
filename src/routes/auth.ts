import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { createUser, findUserByEmail, getUserById, publicUser } from '../repo'
import { hashPassword, verifyPassword } from '../auth'
import { isFirebaseConfigured, verifyFirebaseToken } from '../firebase'
import { SERVICE_LINES, type ServiceLine } from '../types'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const AVATAR = ['#2f6bff', '#0f8a5f', '#a97bff', '#c4820b', '#d64a41', '#1f9d63', '#0e8bab']

function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return AVATAR[Math.abs(hash) % AVATAR.length]
}

interface SignupBody {
  name?: string
  company?: string
  email?: string
  password?: string
  department?: string
}
interface LoginBody {
  email?: string
  password?: string
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: SignupBody }>('/signup', async (req, reply) => {
    const { name, company, email, password, department } = req.body ?? {}
    if (!name?.trim() || !company?.trim() || !EMAIL_RE.test(email ?? '') || (password ?? '').length < 8) {
      return reply.code(400).send({ error: 'Please provide a name, company, valid email and an 8+ character password.' })
    }
    // Department is optional but, when given, must be a known service line.
    if (department && !SERVICE_LINES.includes(department as ServiceLine)) {
      return reply.code(400).send({ error: 'Unknown service department.' })
    }
    const normalized = email!.trim().toLowerCase()
    if (findUserByEmail(normalized)) {
      return reply.code(409).send({ error: 'An account with that email already exists.' })
    }
    const user = createUser({
      name: name.trim(),
      company: company.trim(),
      email: normalized,
      passwordHash: await hashPassword(password!),
      avatarColor: avatarColor(name.trim()),
      department: (department as ServiceLine) || null,
    })
    const token = app.jwt.sign({ sub: user.id, email: user.email, name: user.name, role: user.role })
    return reply.code(201).send({ token, user: publicUser(user) })
  })

  app.post<{ Body: LoginBody }>('/login', async (req, reply) => {
    const { email, password } = req.body ?? {}
    const user = findUserByEmail((email ?? '').trim().toLowerCase())
    if (!user || !(await verifyPassword(password ?? '', user.passwordHash))) {
      return reply.code(401).send({ error: 'Incorrect email or password.' })
    }
    const token = app.jwt.sign({ sub: user.id, email: user.email, name: user.name, role: user.role })
    return { token, user: publicUser(user) }
  })

  app.get('/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = getUserById(req.user.sub)
    if (!user) return reply.code(404).send({ error: 'User not found.' })
    return publicUser(user)
  })

  /**
   * Hybrid-bridge sign-in: the client authenticates with Firebase (Google,
   * email link, phone, …) and posts its Firebase ID token here. We verify the
   * token against Google's public keys, then find-or-create the matching
   * Support Ticker user and issue OUR app JWT — so every downstream API keeps working exactly
   * as it does for password logins. Federated identity in, app session out.
   */
  app.post<{ Body: { idToken?: string } }>('/firebase', async (req, reply) => {
    if (!isFirebaseConfigured()) {
      return reply.code(503).send({ error: 'Social sign-in is not enabled on the server.' })
    }
    const idToken = req.body?.idToken
    if (!idToken) return reply.code(400).send({ error: 'Missing Firebase ID token.' })

    let identity
    try {
      identity = await verifyFirebaseToken(idToken)
    } catch (err) {
      app.log.warn(`Firebase token verification failed: ${(err as Error).message}`)
      return reply.code(401).send({ error: 'Could not verify your sign-in. Please try again.' })
    }

    // Phone-only sign-ins have no email — synthesise a stable local identifier
    // (under the org domain) so the user maps to a single account across sessions.
    const domain = (process.env.ORG_EMAIL_DOMAIN ?? 'gifsonservices.com').toLowerCase()
    const digits = identity.phoneNumber?.replace(/\D/g, '')
    const email = identity.email ?? (digits ? `${digits}@phone.${domain}` : `${identity.uid}@firebase.${domain}`)
    const displayName =
      identity.name?.trim() ||
      (identity.email ? identity.email.split('@')[0] : undefined) ||
      (identity.phoneNumber ? `Member ${digits?.slice(-4)}` : `${process.env.ORG_NAME ?? 'GifsonServices'} Member`)

    let user = findUserByEmail(email)
    if (!user) {
      // Federated users have no password; store a random hash they can't use to
      // log in via the password route (they always come through Firebase).
      user = createUser({
        name: displayName,
        company: 'Personal',
        email,
        passwordHash: await hashPassword(randomUUID()),
        avatarColor: avatarColor(displayName),
      })
    }

    const token = app.jwt.sign({ sub: user.id, email: user.email, name: user.name, role: user.role })
    return reply.code(200).send({ token, user: publicUser(user) })
  })
}
