/**
 * SLA escalation watcher.
 *
 * Policy:
 *   • A HIGH-priority (high/urgent) request left UNTREATED (open/pending — the
 *     owner hasn't started) for longer than the threshold is AUTO-REASSIGNED to
 *     the NEXT assignee in its service department (round-robin). Each reassign
 *     resets the clock, so it keeps rotating until someone picks it up.
 *   • If there is NO OTHER available assignee to move it to (empty department
 *     roster, or the sole member is already the owner), it's ESCALATED by email
 *     to the admin instead (deduped so we don't email every cycle).
 *
 * Runs in-process on a timer; all state (roster, tickets) is read from the repo.
 * Env: ESCALATION_MINUTES (default 2), ESCALATION_CHECK_SECONDS (default 30),
 *      ESCALATION_PRIORITIES (default "high,urgent").
 */
import { listAssignable, listTickets, setAssignee } from './repo'
import type { ServiceLine } from './types'
import { adminEmail, notifyRequesterOfChange, sendEscalationEmail } from './mailer'

/**
 * Agents that can take a request in this service department right now: members
 * of the department whose self-set availability is 'available' (excludes 'busy'
 * and 'offline'). An empty result = "no available assignee" → escalate to admin.
 * Centralized so both the SLA watcher and the on-initiation check use it.
 */
export function availableAssignees(serviceLine: ServiceLine): string[] {
  return listAssignable(serviceLine)
    .filter((m) => m.availability === 'available')
    .map((m) => m.name)
}

const THRESHOLD_MS = Number(process.env.ESCALATION_MINUTES ?? 2) * 60_000
const CHECK_MS = Number(process.env.ESCALATION_CHECK_SECONDS ?? 30) * 1_000
const HIGH = new Set(
  (process.env.ESCALATION_PRIORITIES ?? 'high,urgent').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean),
)
// "Untreated" = assigned-but-not-started (pending) or still in the open pool.
const UNTREATED = new Set(['open', 'pending'])

// Ticket ids already admin-escalated for "no available assignee" — cleared when
// the ticket is treated/assigned, so each stuck request emails the admin once.
const noAssigneeEscalated = new Set<number>()

/** Next assignee after `current` in the roster (round-robin). Returns null when
 *  there is no OTHER assignee to move to. */
function nextAssignee(roster: string[], current: string | null): string | null {
  if (roster.length === 0) return null
  if (roster.length === 1) return roster[0] === current ? null : roster[0]
  const i = current ? roster.indexOf(current) : -1
  return roster[(i + 1) % roster.length] // i === -1 → roster[0]
}

let sweeping = false

async function sweep(log: (m: string) => void): Promise<void> {
  if (sweeping) return // don't overlap slow email sends with the next tick
  sweeping = true
  try {
    const now = Date.now()
    for (const t of listTickets()) {
      const treated = !UNTREATED.has(t.status)
      if (treated) {
        noAssigneeEscalated.delete(t.id)
        continue
      }
      if (!HIGH.has(t.priority)) continue
      const ageMs = now - new Date(t.updatedAt).getTime()
      if (ageMs < THRESHOLD_MS) continue

      const roster = availableAssignees(t.serviceLine)
      const next = nextAssignee(roster, t.assignee)
      if (next) {
        const reassigned = setAssignee(t.id, next, 'Auto-escalation') // resets the clock + logs the reassignment
        noAssigneeEscalated.delete(t.id)
        // Keep the requester informed of the new owner (best-effort).
        if (reassigned) await notifyRequesterOfChange(reassigned, { kind: 'assignment', actor: 'the support team' })
        log(`Ticket #${t.id} (${t.priority}) untreated ${Math.round(ageMs / 60_000)}m → auto-reassigned to ${next}`)
      } else if (!noAssigneeEscalated.has(t.id)) {
        // No other available assignee for this service → escalate to the admin.
        noAssigneeEscalated.add(t.id)
        await sendEscalationEmail(
          `Escalation: high-priority request #${t.id} has no available assignee (${t.serviceLine})`,
          `Request #${t.id} "${t.subject}" is ${t.priority} priority and still ${t.status}, ` +
            `but there is no available assignee in the ${t.serviceLine} department to route it to.\n\n` +
            `Please assign an owner or add an agent to that department.`,
        )
        log(`Ticket #${t.id}: no available assignee in ${t.serviceLine} → escalated to ${adminEmail()}`)
      }
    }
  } finally {
    sweeping = false
  }
}

/** Start the periodic watcher. Returns a stop() function. */
export function startEscalationWatcher(log: (m: string) => void = console.info): () => void {
  const timer = setInterval(() => void sweep(log), CHECK_MS)
  timer.unref?.() // don't keep the process alive just for this
  log(
    `SLA escalation watcher started — reassign ${[...HIGH].join('/')} requests untreated > ` +
      `${THRESHOLD_MS / 60_000}m (checking every ${CHECK_MS / 1_000}s)`,
  )
  return () => clearInterval(timer)
}
