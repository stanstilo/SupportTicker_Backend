import type { Ticket, TicketStatus } from './types'

const ARCHIVED_STATUSES: TicketStatus[] = ['resolved', 'closed']

/**
 * Whether a request may be deleted. Mirrors the client-side predicate in
 * `src/lib/constants.ts` (keep the two in sync).
 * - An in-progress request is actively being treated — never deletable, by anyone.
 * - Admins may delete any other request, including archived (resolved/closed) ones.
 * - Agents may never delete archived requests; otherwise only an open request that
 *   is still unassigned, or a pending request that has been assigned.
 */
export function canDeleteTicket(ticket: Pick<Ticket, 'status' | 'assignee'>, isAdmin: boolean): boolean {
  if (ticket.status === 'in_progress') return false
  if (isAdmin) return true
  if (ARCHIVED_STATUSES.includes(ticket.status)) return false
  const assigned = !!ticket.assignee
  if (ticket.status === 'open') return !assigned
  if (ticket.status === 'pending') return assigned
  return false
}
