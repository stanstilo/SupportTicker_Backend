/**
 * Minimal SMTP mailer (nodemailer) for operational escalation emails.
 *
 * Fully env-configured and best-effort: with no SMTP_* vars this is a no-op that
 * logs what it WOULD have sent, so the app runs fine locally without a mailbox.
 *
 * Env:
 *   SMTP_HOST        e.g. smtp.office365.com
 *   SMTP_PORT        default 587
 *   SMTP_SECURE      "true" for implicit TLS (port 465); default false (STARTTLS)
 *   SMTP_USER        mailbox / login
 *   SMTP_PASS        password / app password
 *   SMTP_FROM        From header (defaults to SMTP_USER, else the admin address)
 *   ADMIN_EMAIL      escalation recipient (must start with "admin@"); otherwise
 *                    derived as admin@<ORG_EMAIL_DOMAIN>
 */
import nodemailer, { type Transporter } from 'nodemailer'
import { STATUS_LABELS, type Ticket } from './types'

// `undefined` = not yet resolved; `null` = resolved-but-unconfigured.
let _transport: Transporter | null | undefined

function getTransport(): Transporter | null {
  if (_transport !== undefined) return _transport
  const host = process.env.SMTP_HOST?.trim()
  const user = process.env.SMTP_USER?.trim()
  const pass = process.env.SMTP_PASS?.trim()
  if (!host || !user || !pass) {
    _transport = null
    return null
  }
  _transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: String(process.env.SMTP_SECURE ?? '').toLowerCase() === 'true',
    auth: { user, pass },
  })
  return _transport
}

export function isMailerConfigured(): boolean {
  return getTransport() !== null
}

/** The escalation recipient. Always an admin@… address, per policy: an explicit
 *  ADMIN_EMAIL is honored only when it starts with "admin@"; otherwise it's
 *  derived from the org email domain. */
export function adminEmail(): string {
  const explicit = process.env.ADMIN_EMAIL?.trim()
  if (explicit && explicit.toLowerCase().startsWith('admin@')) return explicit
  const domain = (process.env.ORG_EMAIL_DOMAIN ?? process.env.ORG_DOMAIN ?? 'gifsonservices.com')
    .toLowerCase()
    .replace(/^@/, '')
  return `admin@${domain}`
}

/** Best-effort send. Never throws; returns whether it was actually sent. When
 *  SMTP isn't configured it logs what it WOULD have sent and returns false, so
 *  the app runs locally without a mailbox. `tag` just labels the log line. */
async function deliver(to: string, subject: string, text: string, tag: string): Promise<boolean> {
  const transport = getTransport()
  if (!transport) {
    // eslint-disable-next-line no-console
    console.warn(`[${tag}] mailer not configured (set SMTP_*) — would email ${to}: ${subject}`)
    return false
  }
  const from = process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim() || adminEmail()
  try {
    await transport.sendMail({ from, to, subject, text })
    // eslint-disable-next-line no-console
    console.info(`[${tag}] emailed ${to}: ${subject}`)
    return true
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[${tag}] email to ${to} failed: ${(err as Error).message}`)
    return false
  }
}

/** Send an escalation email. Never throws; returns whether it was actually sent. */
export async function sendEscalationEmail(subject: string, text: string, to: string = adminEmail()): Promise<boolean> {
  return deliver(to, subject, text, 'escalation')
}

/** What triggered a requester notification — shapes the subject line. */
export type TicketChangeKind = 'status' | 'assignment'

/**
 * Email the requester when their request's status or assignment changes.
 * Always states both the current status AND the current owner (that's what the
 * requester asked to know), regardless of which one triggered it. Best-effort:
 * skips silently when there's no requester email, never throws.
 */
export async function notifyRequesterOfChange(
  ticket: Pick<Ticket, 'id' | 'subject' | 'status' | 'assignee' | 'requester' | 'requesterEmail'>,
  change: { kind: TicketChangeKind; actor: string },
): Promise<boolean> {
  const to = ticket.requesterEmail?.trim()
  if (!to) return false

  const statusLabel = STATUS_LABELS[ticket.status]
  const owner = ticket.assignee ?? 'Unassigned'
  const subject =
    change.kind === 'assignment'
      ? `Your request #${ticket.id} was assigned to ${owner}`
      : `Your request #${ticket.id} is now ${statusLabel}`

  const text =
    `Hi ${ticket.requester},\n\n` +
    `There's an update on your request #${ticket.id} — "${ticket.subject}".\n\n` +
    `  • Status:       ${statusLabel}\n` +
    `  • Assigned to:  ${owner}\n\n` +
    `Updated by ${change.actor}.\n\n` +
    `We'll email you again as it progresses. No reply is needed.`

  return deliver(to, subject, text, 'notify')
}
