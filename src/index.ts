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
import { assistantRoutes } from './routes/assistant'
import { rateRoutes } from './routes/rates'
import { isKycConfigured, kycProvider, isIdentityProviderConfigured } from './kyc'
import { isOrchestratorConfigured } from './orchestrator'
import { isDataverseConfigured } from './dataverse'
import { isFirebaseConfigured } from './firebase'
import { startEscalationWatcher } from './escalation'
import { isMailerConfigured, adminEmail } from './mailer'

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
  await app.register(assistantRoutes, { prefix: '/api/assistant' })
  await app.register(rateRoutes, { prefix: '/api' })

  await app.listen({ port: PORT, host: '0.0.0.0' })

  // SLA escalation: auto-reassign high-priority, untreated requests to the next
  // agent in their department; email the admin when there's no one to route to.
  startEscalationWatcher((m) => app.log.info(m))
  if (isMailerConfigured()) {
    app.log.info(`Escalation email ENABLED → admin ${adminEmail()} (via SMTP ${process.env.SMTP_HOST})`)
  } else {
    app.log.warn(`Escalation email DISABLED — set SMTP_* in .env to email the admin (${adminEmail()}); reassignment still works`)
  }

  if (isOrchestratorConfigured()) {
    app.log.info(`Orchestrator enqueue ENABLED → queue "${process.env.ORCH_QUEUE_NAME ?? 'HelixNewTickets'}"`)
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

  if (isIdentityProviderConfigured()) {
    app.log.info('KYC identity (BVN/NIN/document): Dojah PRIMARY → real NIBSS/NIMC lookups + document analysis')
  } else {
    app.log.warn('KYC identity (BVN/NIN/document): no provider — set DOJAH_APP_ID/DOJAH_API_KEY for real checks; using format-check fallback')
  }

  const sttService = process.env.STT_SERVICE_URL?.trim() || process.env.TTS_SERVICE_URL?.trim() || 'http://127.0.0.1:8081'
  app.log.info(`Voice STT: self-hosted Whisper PRIMARY (${sttService}/transcribe)${process.env.OPENAI_API_KEY?.trim() ? ' → OpenAI fallback' : ''}`)
  if (process.env.OPENAI_API_KEY?.trim()) {
    app.log.info('Chat assistant ENABLED (OpenAI)')
  } else {
    app.log.warn('Chat assistant DISABLED — set OPENAI_API_KEY in .env; the chat falls back to canned replies')
  }
}

main().catch((err) => {
  // A stuck/duplicate instance already owns the port — give a clear, actionable
  // message instead of a raw stack trace.
  if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
    console.error(
      `\nPort ${PORT} is already in use — another server instance is still running.\n` +
        `Stop it and retry, or start on a different port with PORT=<n>.\n` +
        `  • Windows:  netstat -ano | findstr :${PORT}   then   taskkill /PID <pid> /F\n` +
        `  • macOS/Linux:  lsof -ti:${PORT} | xargs kill -9\n`,
    )
    process.exit(1)
  }
  console.error(err)
  process.exit(1)
})
