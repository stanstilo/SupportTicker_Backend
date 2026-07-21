// Load .env if present (built into Node 21+, no dependency). Populates ORCH_* etc.
try {
  process.loadEnvFile()
} catch {
  /* no .env file — fine */
}

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { initDb } from './db'
import { seedIfEmpty } from './seed'
import { registerAuth } from './auth'
import { authRoutes } from './routes/auth'
import { ticketRoutes } from './routes/tickets'
import { accountRoutes } from './routes/accounts'
import { userRoutes } from './routes/users'
import { kycRoutes } from './routes/kyc'
import { organizationRoutes } from './routes/organizations'
import { isKycConfigured, kycProvider } from './kyc'
import { isOrchestratorConfigured } from './orchestrator'
import { isDataverseConfigured } from './dataverse'
import { isFirebaseConfigured } from './firebase'

const PORT = Number(process.env.PORT ?? 4000)

async function main(): Promise<void> {
  initDb()
  await seedIfEmpty()

  const app = Fastify({
    logger: true,
    // Attachments carry base64 data URLs — allow a generous body size.
    bodyLimit: 30 * 1024 * 1024,
  })

  await app.register(cors, { origin: true })
  await registerAuth(app)

  app.get('/api/health', async () => ({ ok: true, service: 'support-ticker-api' }))
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(ticketRoutes, { prefix: '/api/tickets' })
  await app.register(accountRoutes, { prefix: '/api' })
  await app.register(userRoutes, { prefix: '/api/users' })
  await app.register(kycRoutes, { prefix: '/api/kyc' })
  await app.register(organizationRoutes, { prefix: '/api/org' })

  await app.listen({ port: PORT, host: '0.0.0.0' })

  if (isOrchestratorConfigured()) {
    app.log.info(`Orchestrator enqueue ENABLED → queue "${process.env.ORCH_QUEUE_NAME ?? 'SupportTickerNewTickets'}"`)
  } else {
    app.log.warn('Orchestrator enqueue DISABLED — set ORCH_* in .env to trigger the UiPath workflow on submit')
  }

  if (isDataverseConfigured()) {
    app.log.info(`CRM source: Dataverse PRIMARY (${process.env.DATAVERSE_BASE_URL}) → SQLite fallback`)
  } else {
    app.log.warn('CRM source: SQLite only — set DATAVERSE_* in .env to serve accounts/contacts from Dataverse')
  }

  if (isFirebaseConfigured()) {
    app.log.info(`Social sign-in ENABLED → verifying Firebase tokens for project "${process.env.FIREBASE_PROJECT_ID}"`)
  } else {
    app.log.warn('Social sign-in DISABLED — set FIREBASE_PROJECT_ID in .env to accept Firebase (Google/phone/email-link) logins')
  }

  if (isKycConfigured()) {
    app.log.info(`KYC face verification: server provider "${kycProvider()}" ENABLED (client falls back on error)`)
  } else {
    app.log.warn('KYC face verification: no server provider — set KYC_PROVIDER (smileid|dojah|mock); client verifies on-device')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
