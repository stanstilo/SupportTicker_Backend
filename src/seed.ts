import { randomUUID } from 'node:crypto'
import { db } from './db'
import { countTickets, createOrganization, findUserByEmail, primaryOrganization } from './repo'
import { hashPassword } from './auth'

const AVATAR = ['#2f6bff', '#0f8a5f', '#a97bff', '#c4820b', '#d64a41', '#1f9d63']

const H = 36e5
const now = Date.now()
const iso = (hoursAgo: number) => new Date(now - hoursAgo * H).toISOString()
const dueIn = (hours: number) => new Date(now + hours * H).toISOString()

const accounts = [
  ['acc-contoso', 'Contoso Ltd.', 'contoso.com', 'Enterprise', 'Manufacturing', 38500, 67, '2024-05-02T10:00:00Z'],
  ['acc-fabrikam', 'Fabrikam Inc.', 'fabrikam.io', 'Business', 'Retail', 12400, 91, '2024-08-19T10:00:00Z'],
] as const

const contacts = [
  ['c2', 'Liam Chen', 'liam@contoso.com', 'Finance Lead', 'acc-contoso', AVATAR[1]],
  ['c3', 'Noah Patel', 'noah@fabrikam.io', 'Product Manager', 'acc-fabrikam', AVATAR[2]],
  ['c4', 'Mia Rodriguez', 'mia@contoso.com', 'Operations', 'acc-contoso', AVATAR[3]],
  ['c7', 'Oliver Brooks', 'oliver@fabrikam.io', 'Marketing', 'acc-fabrikam', AVATAR[0]],
] as const

interface SeedActivity {
  kind: string
  author: string
  body: string
  createdAt: string
  internal?: boolean
}
interface SeedTicket {
  id: number
  subject: string
  description: string
  status: string
  priority: string
  serviceLine: string
  channel: string
  requester: string
  requesterEmail: string
  accountId: string
  assignee: string | null
  tags: string[]
  feedback: { rating: number; comment?: string; createdAt: string } | null
  createdAt: string
  updatedAt: string
  slaDueAt: string
  activity: SeedActivity[]
}

const tickets: SeedTicket[] = [
  {
    id: 1041, subject: 'Invoice shows wrong amount',
    description: 'Our latest invoice is $1,240 higher than expected. We were not notified of any plan change.',
    status: 'pending', priority: 'high', serviceLine: 'crm', channel: 'web',
    requester: 'Liam Chen', requesterEmail: 'liam@contoso.com', accountId: 'acc-contoso', assignee: 'Marcus Lee',
    tags: ['billing'], feedback: null, createdAt: iso(26), updatedAt: iso(2), slaDueAt: dueIn(6),
    activity: [
      { kind: 'created', author: 'Liam Chen', body: 'Request created via web portal.', createdAt: iso(26) },
      { kind: 'comment', author: 'Marcus Lee', body: 'Waiting on confirmation from the billing team.', internal: true, createdAt: iso(2) },
    ],
  },
  {
    id: 1040, subject: 'Feature request: dark mode',
    description: 'Would love a dark theme for the dashboard — our team works late and the bright UI is hard on the eyes.',
    status: 'open', priority: 'low', serviceLine: 'professional-services', channel: 'web',
    requester: 'Noah Patel', requesterEmail: 'noah@fabrikam.io', accountId: 'acc-fabrikam', assignee: null,
    tags: ['feature-request', 'ux'], feedback: null, createdAt: iso(41), updatedAt: iso(41), slaDueAt: dueIn(70),
    activity: [{ kind: 'created', author: 'Noah Patel', body: 'Request created via web portal.', createdAt: iso(41) }],
  },
  {
    id: 1039, subject: 'App crashes on export',
    description: 'The app crashes every time we try to export a report larger than ~5,000 rows. Console shows an out-of-memory error.',
    status: 'open', priority: 'urgent', serviceLine: 'support', channel: 'chat',
    requester: 'Mia Rodriguez', requesterEmail: 'mia@contoso.com', accountId: 'acc-contoso', assignee: 'Dana Okafor',
    tags: ['crash', 'export', 'performance'], feedback: null, createdAt: iso(42), updatedAt: iso(3), slaDueAt: dueIn(1),
    activity: [
      { kind: 'created', author: 'Mia Rodriguez', body: 'Request created via chat.', createdAt: iso(42) },
      { kind: 'priority', author: 'Dana Okafor', body: 'Raised priority to Urgent.', createdAt: iso(4) },
    ],
  },
  {
    id: 1036, subject: 'Typo on pricing page',
    description: 'The annual plan price on the pricing page says "$99/mo" but should be "$990/yr".',
    status: 'closed', priority: 'low', serviceLine: 'professional-services', channel: 'web',
    requester: 'Oliver Brooks', requesterEmail: 'oliver@fabrikam.io', accountId: 'acc-fabrikam', assignee: 'Tom Becker',
    tags: ['content'], feedback: { rating: 4, createdAt: iso(60) }, createdAt: iso(66), updatedAt: iso(60), slaDueAt: dueIn(-40),
    activity: [
      { kind: 'created', author: 'Oliver Brooks', body: 'Request created via web portal.', createdAt: iso(66) },
      { kind: 'status', author: 'Tom Becker', body: 'Fixed and deployed. Closing.', createdAt: iso(60) },
    ],
  },
  {
    id: 1034, subject: 'Data not syncing on mobile',
    description: 'Changes made on desktop take hours to appear on the mobile app, if at all.',
    status: 'pending', priority: 'normal', serviceLine: 'support', channel: 'chat',
    requester: 'James Wright', requesterEmail: 'james@contoso.com', accountId: 'acc-contoso', assignee: 'Sofia Rossi',
    tags: ['sync', 'mobile'], feedback: null, createdAt: iso(80), updatedAt: iso(9), slaDueAt: dueIn(12),
    activity: [{ kind: 'created', author: 'James Wright', body: 'Request created via chat.', createdAt: iso(80) }],
  },
]

/** Seeds reference data + a demo account on first boot. Idempotent. */
export async function seedIfEmpty(): Promise<void> {
  // The owning organization. Change ORG_NAME / ORG_DOMAIN (or manage it live in
  // Admin → Organization) to rebrand. The domain identifies the org's people:
  // anyone@<domain> is an onboarded member, and their requests map to the org.
  const orgName = process.env.ORG_NAME ?? 'GifsonServices'
  const domain = (process.env.ORG_DOMAIN ?? process.env.ORG_EMAIL_DOMAIN ?? 'gifsonservices.onmicrosoft.com').toLowerCase().replace(/^@/, '')

  // Seed the primary organization on first boot (idempotent).
  if (!primaryOrganization()) {
    createOrganization({ name: orgName, domain, makePrimary: true })
  }

  const adminEmail = (process.env.ADMIN_EMAIL ?? `admin@${domain}`).toLowerCase()
  const superEmail = (process.env.SUPERADMIN_EMAIL ?? `superadmin@${domain}`).toLowerCase()
  const superPassword = process.env.SUPERADMIN_PASSWORD ?? 'super1234'

 

  if (!findUserByEmail(adminEmail)) {
    const passwordHash = await hashPassword('admin1234')
    db.prepare(
      `INSERT INTO users (id, name, email, company, password_hash, avatar_color, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), 'Admin User', adminEmail, orgName, passwordHash, AVATAR[2], 'admin', '2026-01-04T09:00:00Z')
  }

  // Initial super admin — the RBAC root that can grant/revoke admin access.
  if (!findUserByEmail(superEmail)) {
    const passwordHash = await hashPassword(superPassword)
    db.prepare(
      `INSERT INTO users (id, name, email, company, password_hash, avatar_color, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), 'Super Admin', superEmail, orgName, passwordHash, AVATAR[4], 'superadmin', '2026-01-04T09:00:00Z')
  }

  // Enforce roles idempotently, even for databases seeded before roles existed.
  db.prepare(`UPDATE users SET role = 'superadmin' WHERE email = ?`).run(superEmail)
  db.prepare(`UPDATE users SET role = 'admin' WHERE email = ?`).run(adminEmail)
  // db.prepare(`UPDATE users SET role = 'agent' WHERE email = ?`).run(demoEmail)

  // Demo service-department agents so the assignment dropdowns are populated out
  // of the box (password: agent1234). Real users get their department at sign-up;
  // these are safe to delete. Idempotent + department kept in sync on re-seed.
  const AGENTS: [name: string, local: string, department: string, avatar: string][] = [
    ['Boomarobe', 'boomarobe', 'support', AVATAR[0]],
    ['Royal', 'royal', 'support', AVATAR[1]],
    ['Sound Cloner', 'souncloner', 'payments', AVATAR[2]],
    ['Yalebs Tech', 'yalebstech', 'payments', AVATAR[3]],
    ['Ada', 'ada', 'support', AVATAR[4]],
    ['Clara', 'clara', 'payments', AVATAR[5]],
    ['Stephen', 'stephen', 'retail banking', AVATAR[0]],
  ]
  const agentHash = await hashPassword('agent1234')
  for (const [name, local, department, avatar] of AGENTS) {
    const agentEmail = `${local}@${domain}`
    if (!findUserByEmail(agentEmail)) {
      db.prepare(
        `INSERT INTO users (id, name, email, company, password_hash, avatar_color, role, department, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'agent', ?, ?)`,
      ).run(randomUUID(), name, agentEmail, orgName, agentHash, avatar, department, '2026-01-05T09:00:00Z')
    }
    // Keep department current even for a pre-existing row.
    db.prepare(`UPDATE users SET department = ? WHERE email = ?`).run(department, agentEmail)
  }

  if (countTickets() > 0) return

  const seed = db.transaction(() => {
    for (const a of accounts) {
      db.prepare(
        `INSERT OR IGNORE INTO accounts (id, name, domain, tier, industry, mrr, health_score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...a)
    }
    for (const c of contacts) {
      db.prepare(
        `INSERT OR IGNORE INTO contacts (id, name, email, role, account_id, avatar_color)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(...c)
    }
    for (const t of tickets) {
      db.prepare(
        `INSERT INTO tickets
           (id, subject, description, status, priority, service_line, channel,
            requester, requester_email, account_id, assignee, tags, created_at, updated_at, sla_due_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        t.id, t.subject, t.description, t.status, t.priority, t.serviceLine, t.channel,
        t.requester, t.requesterEmail, t.accountId, t.assignee, JSON.stringify(t.tags),
        t.createdAt, t.updatedAt, t.slaDueAt,
      )
      for (const act of t.activity) {
        db.prepare(
          `INSERT INTO activity (id, ticket_id, kind, author, body, internal, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), t.id, act.kind, act.author, act.body, act.internal ? 1 : 0, act.createdAt)
      }
      if (t.feedback) {
        db.prepare(
          `INSERT INTO feedback (ticket_id, rating, comment, created_at) VALUES (?, ?, ?, ?)`,
        ).run(t.id, t.feedback.rating, t.feedback.comment ?? null, t.feedback.createdAt)
      }
    }
  })
  seed()
}
