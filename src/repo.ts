import { randomUUID } from 'node:crypto'
import { db } from './db'
import {
  PRIORITY_LABELS,
  STATUS_LABELS,
  type Account,
  type Activity,
  type ActivityKind,
  type Attachment,
  type AuthUser,
  type Contact,
  type Feedback,
  type NewTicketInput,
  type ServiceLine,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
  type UserRecord,
  type UserRole,
  type UserSummary,
} from './types'

const now = () => new Date().toISOString()

/* ------------------------------------------------------------- organizations */

function rowToOrg(row: Record<string, unknown> | undefined): import('./types').Organization | undefined {
  if (!row) return undefined
  return {
    id: row.id as string,
    name: row.name as string,
    domain: row.domain as string,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at as string,
  }
}

export function listOrganizations(): import('./types').Organization[] {
  return (db.prepare('SELECT * FROM organizations ORDER BY is_primary DESC, name').all() as Record<string, unknown>[])
    .map((r) => rowToOrg(r)!)
}

export function getOrganization(id: string): import('./types').Organization | undefined {
  return rowToOrg(db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as never)
}

export function primaryOrganization(): import('./types').Organization | undefined {
  return rowToOrg(db.prepare('SELECT * FROM organizations WHERE is_primary = 1').get() as never)
}

export function findOrganizationByDomain(domain: string): import('./types').Organization | undefined {
  return rowToOrg(db.prepare('SELECT * FROM organizations WHERE domain = ?').get(domain.toLowerCase()) as never)
}

export function countOrganizations(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number }).n
}

export function createOrganization(input: { name: string; domain: string; makePrimary?: boolean }): import('./types').Organization {
  const org = {
    id: randomUUID(),
    name: input.name.trim(),
    domain: input.domain.trim().toLowerCase().replace(/^@/, ''),
    createdAt: now(),
  }
  const makePrimary = input.makePrimary || countOrganizations() === 0
  const tx = db.transaction(() => {
    if (makePrimary) db.prepare('UPDATE organizations SET is_primary = 0').run()
    db.prepare(
      `INSERT INTO organizations (id, name, domain, is_primary, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(org.id, org.name, org.domain, makePrimary ? 1 : 0, org.createdAt)
  })
  tx()
  return getOrganization(org.id)!
}

export function updateOrganization(id: string, input: { name?: string; domain?: string }): import('./types').Organization | undefined {
  const existing = getOrganization(id)
  if (!existing) return undefined
  const name = input.name?.trim() || existing.name
  const domain = (input.domain?.trim().toLowerCase().replace(/^@/, '')) || existing.domain
  db.prepare('UPDATE organizations SET name = ?, domain = ? WHERE id = ?').run(name, domain, id)
  return getOrganization(id)
}

/** Make one org the primary owner (single-primary invariant). */
export function setPrimaryOrganization(id: string): import('./types').Organization | undefined {
  if (!getOrganization(id)) return undefined
  const tx = db.transaction(() => {
    db.prepare('UPDATE organizations SET is_primary = 0').run()
    db.prepare('UPDATE organizations SET is_primary = 1 WHERE id = ?').run(id)
  })
  tx()
  return getOrganization(id)
}

export function deleteOrganization(id: string): boolean {
  return db.prepare('DELETE FROM organizations WHERE id = ?').run(id).changes > 0
}

/** Map an email to the name of the organization that owns its domain, if any. */
export function organizationForEmail(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null
  const domain = email.split('@')[1].toLowerCase()
  const org = findOrganizationByDomain(domain)
  return org ? org.name : null
}

/* ------------------------------------------------------------------ users */

export function createUser(input: {
  name: string
  email: string
  company: string
  passwordHash: string
  avatarColor: string
  role?: UserRole
  department?: ServiceLine | null
}): UserRecord {
  const user: UserRecord = {
    id: randomUUID(),
    name: input.name,
    email: input.email,
    company: input.company,
    passwordHash: input.passwordHash,
    avatarColor: input.avatarColor,
    role: input.role ?? 'agent',
    department: input.department ?? null,
    createdAt: now(),
  }
  db.prepare(
    `INSERT INTO users (id, name, email, company, password_hash, avatar_color, role, department, created_at)
     VALUES (@id, @name, @email, @company, @passwordHash, @avatarColor, @role, @department, @createdAt)`,
  ).run(user)
  return user
}

function rowToUser(row: Record<string, unknown> | undefined): UserRecord | undefined {
  if (!row) return undefined
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    company: row.company as string,
    passwordHash: row.password_hash as string,
    avatarColor: row.avatar_color as string,
    role: (row.role as UserRole) ?? 'agent',
    department: (row.department as ServiceLine | null) ?? null,
    createdAt: row.created_at as string,
  }
}

export function findUserByEmail(email: string): UserRecord | undefined {
  return rowToUser(db.prepare('SELECT * FROM users WHERE email = ?').get(email) as never)
}

export function getUserById(id: string): UserRecord | undefined {
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as never)
}

export function publicUser(user: UserRecord): AuthUser {
  const { id: _id, passwordHash: _pw, ...rest } = user
  return rest
}

/* ------------------------------------------------------- users (RBAC admin) */

function rowToSummary(row: Record<string, unknown>): UserSummary {
  return {
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
    company: row.company as string,
    avatarColor: row.avatar_color as string,
    role: (row.role as UserRole) ?? 'agent',
    department: (row.department as ServiceLine | null) ?? null,
    createdAt: row.created_at as string,
  }
}

/** Every user, newest first — for the admin user & role table. */
export function listUsers(): UserSummary[] {
  return (db.prepare('SELECT * FROM users ORDER BY created_at').all() as Record<string, unknown>[]).map(rowToSummary)
}

export function getUserSummary(id: string): UserSummary | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToSummary(row) : undefined
}

/** Update a user's role. Returns the updated summary, or undefined if missing. */
export function setUserRole(id: string, role: UserRole): UserSummary | undefined {
  const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id)
  if (result.changes === 0) return undefined
  return getUserSummary(id)
}

/** Set (or clear) a user's service department. Returns the updated summary. */
export function setUserDepartment(id: string, department: ServiceLine | null): UserSummary | undefined {
  const result = db.prepare('UPDATE users SET department = ? WHERE id = ?').run(department, id)
  if (result.changes === 0) return undefined
  return getUserSummary(id)
}

/** Members of a given service department — the pool a request in that service
 *  line can be assigned to. Used by both admin assignment and peer hand-off. */
export function listAssignable(department: ServiceLine): Pick<UserSummary, 'name' | 'email' | 'avatarColor' | 'department'>[] {
  return (
    db.prepare('SELECT name, email, avatar_color, department FROM users WHERE department = ? ORDER BY name').all(department) as Record<string, unknown>[]
  ).map((r) => ({
    name: r.name as string,
    email: r.email as string,
    avatarColor: r.avatar_color as string,
    department: (r.department as ServiceLine | null) ?? null,
  }))
}

export function countUsersByRole(role: UserRole): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(role) as { n: number }).n
}

/** Remove a user. Returns true if a row was deleted. Ticket attribution is
 * free-text (submitted_by/assignee/author), so history survives the delete. */
export function deleteUser(id: string): boolean {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0
}

/* --------------------------------------------------------- accounts/contacts */

export function listAccounts(): Account[] {
  return (db.prepare('SELECT * FROM accounts ORDER BY name').all() as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    domain: r.domain as string,
    tier: r.tier as Account['tier'],
    industry: r.industry as string,
    mrr: r.mrr as number,
    healthScore: r.health_score as number,
    createdAt: r.created_at as string,
  }))
}

export function listContacts(): Contact[] {
  return (db.prepare('SELECT * FROM contacts ORDER BY name').all() as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    email: r.email as string,
    role: (r.role as string) ?? undefined,
    accountId: r.account_id as string,
    avatarColor: r.avatar_color as string,
  }))
}

export function accountExists(id: string): boolean {
  return !!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)
}

/* ---------------------------------------------------------------- tickets */

function getAttachments(ticketId: number): Attachment[] {
  return (
    db.prepare('SELECT * FROM attachments WHERE ticket_id = ? ORDER BY created_at').all(ticketId) as Record<
      string,
      unknown
    >[]
  ).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    size: r.size as number,
    type: r.type as string,
    dataUrl: r.data_url as string,
    ocrText: (r.ocr_text as string) ?? undefined,
    createdAt: r.created_at as string,
  }))
}

function getActivity(ticketId: number): Activity[] {
  return (
    db.prepare('SELECT * FROM activity WHERE ticket_id = ? ORDER BY created_at, rowid').all(ticketId) as Record<
      string,
      unknown
    >[]
  ).map((r) => ({
    id: r.id as string,
    kind: r.kind as ActivityKind,
    author: r.author as string,
    body: r.body as string,
    internal: !!r.internal,
    createdAt: r.created_at as string,
  }))
}

function getFeedback(ticketId: number): Feedback | null {
  const r = db.prepare('SELECT * FROM feedback WHERE ticket_id = ?').get(ticketId) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return {
    rating: r.rating as number,
    comment: (r.comment as string) ?? undefined,
    createdAt: r.created_at as string,
  }
}

function rowToTicket(row: Record<string, unknown>): Ticket {
  const id = row.id as number
  return {
    id,
    subject: row.subject as string,
    description: row.description as string,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    serviceLine: row.service_line as Ticket['serviceLine'],
    channel: row.channel as Ticket['channel'],
    requester: row.requester as string,
    requesterEmail: row.requester_email as string,
    accountId: (row.account_id as string) ?? null,
    assignee: (row.assignee as string) ?? null,
    tags: JSON.parse((row.tags as string) || '[]'),
    attachments: getAttachments(id),
    activity: getActivity(id),
    feedback: getFeedback(id),
    submittedBy: (row.submitted_by as string) ?? null,
    onBehalf: !!row.on_behalf,
    assignToMe: !!row.assign_to_me,
    dfRecordId: (row.df_record_id as string) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    slaDueAt: row.sla_due_at as string,
    // Map the request to an org by the submitter's (else requester's) email domain.
    organization:
      organizationForEmail(row.submitted_by as string) ?? organizationForEmail(row.requester_email as string),
  }
}

export function listTickets(): Ticket[] {
  const rows = db.prepare('SELECT * FROM tickets ORDER BY updated_at DESC').all() as Record<string, unknown>[]
  return rows.map(rowToTicket)
}

export function getTicket(id: number): Ticket | undefined {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToTicket(row) : undefined
}

function addActivity(
  ticketId: number,
  kind: ActivityKind,
  author: string,
  body: string,
  internal = false,
  createdAt = now(),
): void {
  db.prepare(
    `INSERT INTO activity (id, ticket_id, kind, author, body, internal, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), ticketId, kind, author, body, internal ? 1 : 0, createdAt)
}

export interface CreateMeta {
  submittedBy: string | null
  onBehalf: boolean
  assignToMe: boolean
  assignee: string | null
}

export function createTicket(input: NewTicketInput, meta: CreateMeta): Ticket {
  const created = now()
  const insertTicket = db.prepare(
    `INSERT INTO tickets
       (subject, description, status, priority, service_line, channel,
        requester, requester_email, account_id, assignee, tags,
        submitted_by, on_behalf, assign_to_me, created_at, updated_at, sla_due_at)
     VALUES
       (@subject, @description, 'open', @priority, @serviceLine, @channel,
        @requester, @requesterEmail, @accountId, @assignee, @tags,
        @submittedBy, @onBehalf, @assignToMe, @createdAt, @createdAt, @slaDueAt)`,
  )

  const tx = db.transaction((): number => {
    const result = insertTicket.run({
      subject: input.subject,
      description: input.description,
      priority: input.priority,
      serviceLine: input.serviceLine,
      channel: input.channel,
      requester: input.requester,
      requesterEmail: input.requesterEmail,
        accountId: input.accountId ?? null,
      assignee: meta.assignee,
      tags: JSON.stringify(input.tags ?? []),
      submittedBy: meta.submittedBy,
      onBehalf: meta.onBehalf ? 1 : 0,
      assignToMe: meta.assignToMe ? 1 : 0,
      createdAt: created,
      // Default SLA: 24h from creation.
      slaDueAt: new Date(Date.now() + 24 * 36e5).toISOString(),
    })
    const ticketId = Number(result.lastInsertRowid)

    addActivity(ticketId, 'created', input.requester, 'Request created via web portal.', false, created)

    for (const a of input.attachments ?? []) {
      db.prepare(
        `INSERT INTO attachments (id, ticket_id, name, size, type, data_url, ocr_text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.id || randomUUID(), ticketId, a.name, a.size, a.type, a.dataUrl, a.ocrText ?? null, a.createdAt || created)
      addActivity(ticketId, 'attachment', input.requester, `Attached ${a.name}.`, false, created)
    }
    return ticketId
  })

  const id = tx()
  return getTicket(id)!
}

function touch(id: number): void {
  db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now(), id)
}

export function setStatus(id: number, status: TicketStatus, actor: string): Ticket | undefined {
  if (!getTicket(id)) return undefined
  db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(status, id)
  addActivity(id, 'status', actor, `Changed status to ${STATUS_LABELS[status]}.`)
  touch(id)
  return getTicket(id)
}

export function setPriority(id: number, priority: TicketPriority, actor: string): Ticket | undefined {
  if (!getTicket(id)) return undefined
  db.prepare('UPDATE tickets SET priority = ? WHERE id = ?').run(priority, id)
  addActivity(id, 'priority', actor, `Changed priority to ${PRIORITY_LABELS[priority]}.`)
  touch(id)
  return getTicket(id)
}

/** Persist the Data Fabric mirror record id (from the UiPath insert process). */
export function setDfRecordId(id: number, dfRecordId: string): void {
  db.prepare('UPDATE tickets SET df_record_id = ? WHERE id = ?').run(dfRecordId, id)
}

export function setAssignee(id: number, assignee: string | null, actor: string): Ticket | undefined {
  const current = getTicket(id)
  if (!current) return undefined
  db.prepare('UPDATE tickets SET assignee = ? WHERE id = ?').run(assignee, id)
  addActivity(id, 'assignment', actor, assignee ? `Assigned to ${assignee}.` : 'Unassigned.')

  // System-driven lifecycle: assigning a person means "assigned, not yet started"
  // (pending); unassigning returns it to the open pool. A reassignment resets an
  // in-progress request to pending (the new owner hasn't started). Terminal
  // states (resolved/closed/declined) are left untouched.
  if (['open', 'pending', 'in_progress'].includes(current.status)) {
    const next: TicketStatus = assignee ? 'pending' : 'open'
    if (next !== current.status) {
      db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run(next, id)
      addActivity(id, 'status', actor, `Changed status to ${STATUS_LABELS[next]}.`)
    }
  }
  touch(id)
  return getTicket(id)
}

export function deleteTicket(id: number): Ticket | undefined {
  const ticket = getTicket(id)
  if (!ticket) return undefined
  db.prepare('DELETE FROM tickets WHERE id = ?').run(id)
  return ticket
}

export function addComment(
  id: number,
  author: string,
  body: string,
  internal: boolean,
): Ticket | undefined {
  if (!getTicket(id)) return undefined
  addActivity(id, 'comment', author, body, internal)
  touch(id)
  return getTicket(id)
}

export function addFeedback(id: number, feedback: Feedback): Ticket | undefined {
  const ticket = getTicket(id)
  if (!ticket) return undefined
  db.prepare(
    `INSERT INTO feedback (ticket_id, rating, comment, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ticket_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = excluded.created_at`,
  ).run(id, feedback.rating, feedback.comment ?? null, feedback.createdAt || now())
  addActivity(id, 'feedback', ticket.requester, `Left a ${feedback.rating}-star rating.`)
  touch(id)
  return getTicket(id)
}

export function countTickets(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM tickets').get() as { n: number }).n
}
