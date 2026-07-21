import type { FastifyInstance } from 'fastify'
import {
  accountExists,
  addComment,
  addFeedback,
  createTicket,
  deleteTicket,
  getTicket,
  listAssignable,
  listTickets,
  setAssignee,
  setDfRecordId,
  setPriority,
  setStatus,
} from '../repo'
import {
  CHANNELS,
  PRIORITIES,
  SERVICE_LINES,
  STATUSES,
  type Channel,
  type Feedback,
  type NewTicketInput,
  type ServiceLine,
  type TicketPriority,
  type TicketStatus,
} from '../types'
import {
  assignByDepartment,
  dataFabricInsert,
  dataFabricUpdate,
  enqueueTicket,
  isOrchestratorConfigured,
} from '../orchestrator'
import { canDeleteTicket } from '../permissions'
import { isAdminRole } from '../types'

export async function ticketRoutes(app: FastifyInstance): Promise<void> {
  // Every ticket route requires a valid session.
  app.addHook('preHandler', app.authenticate)

  app.get('/', async () => listTickets())

  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const ticket = getTicket(Number(req.params.id))
    if (!ticket) return reply.code(404).send({ error: 'Request not found.' })
    return ticket
  })

  app.post<{ Body: Partial<NewTicketInput> }>('/', async (req, reply) => {
    const b = req.body ?? {}
    const onBehalf = !!b.onBehalf
    // Assignee chosen at intake (typeahead or "Assign to me"); default unassigned.
    const assignee = typeof b.assignee === 'string' && b.assignee.trim() ? b.assignee.trim() : null
    const errors: string[] = []
    if (!b.subject?.trim()) errors.push('subject is required')
    if (!b.description?.trim()) errors.push('description is required')
    // The requester fields are only supplied when logging on behalf of someone
    // else; otherwise the requester IS the authenticated submitter.
    if (onBehalf && !b.requester?.trim()) errors.push('requester is required')
    if (onBehalf && !b.requesterEmail?.trim()) errors.push('requesterEmail is required')
    if (!b.priority || !PRIORITIES.includes(b.priority)) errors.push('invalid priority')
    if (!b.serviceLine || !SERVICE_LINES.includes(b.serviceLine)) errors.push('invalid serviceLine')
    if (!b.channel || !CHANNELS.includes(b.channel)) errors.push('invalid channel')
    if (b.accountId && !accountExists(b.accountId)) errors.push('unknown accountId')
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') })

    // Requester = the person the request is for. Self unless logging on behalf.
    const requester = onBehalf ? b.requester!.trim() : req.user.name
    const requesterEmail = onBehalf ? b.requesterEmail!.trim() : req.user.email
    // Record when the submitter assigned the request to themselves.
    const assignToMe = assignee != null && assignee === req.user.name

    const ticket = createTicket(
      {
        subject: b.subject!.trim(),
        description: b.description!.trim(),
        priority: b.priority as TicketPriority,
        serviceLine: b.serviceLine as ServiceLine,
        channel: b.channel as Channel,
        requester,
        requesterEmail,
        accountId: b.accountId ?? null,
        tags: Array.isArray(b.tags) ? b.tags.map((t) => String(t)) : [],
        attachments: Array.isArray(b.attachments) ? b.attachments : [],
      },
      { submittedBy: req.user.email, onBehalf, assignToMe, assignee },
    )

    // App-triggered: enqueue the unassigned request to Orchestrator so a UiPath
    // robot stores it in Data Fabric. Best-effort — never fails ticket creation.
    enqueueTicket(ticket)
      .then((sent) => {
        if (sent) app.log.info(`Ticket #${ticket.id} enqueued to Orchestrator`)
      })
      .catch((err) => app.log.warn(`Orchestrator enqueue failed for #${ticket.id}: ${err.message}`))

    // Backend-driven orchestration: store the ticket in Data Fabric via the
    // UiPath insert process, then resolve an assignee by department (write-back
    // included). Best-effort and fire-and-forget — never blocks/fails creation.
    if (isOrchestratorConfigured()) {
      void (async () => {
        try {
          const recordId = await dataFabricInsert(ticket)
          if (!recordId) return
          setDfRecordId(ticket.id, recordId)
          app.log.info(`Ticket #${ticket.id} stored in Data Fabric (${recordId})`)
          const owner = await assignByDepartment(recordId, ticket.serviceLine)
          if (owner) {
            setAssignee(ticket.id, owner, 'UiPath')
            await dataFabricUpdate(recordId, owner, 'pending')
            app.log.info(`Ticket #${ticket.id} auto-assigned to ${owner} (${ticket.serviceLine})`)
          } else {
            app.log.info(`Ticket #${ticket.id}: no ${ticket.serviceLine} agent — escalate/leave unassigned`)
          }
        } catch (err) {
          app.log.warn(`UiPath orchestration failed for #${ticket.id}: ${(err as Error).message}`)
        }
      })()
    }

    return reply.code(201).send(ticket)
  })

  app.patch<{ Params: { id: string }; Body: { status?: TicketStatus } }>('/:id/status', async (req, reply) => {
    const status = req.body?.status
    if (!status || !STATUSES.includes(status)) return reply.code(400).send({ error: 'Invalid status.' })
    const existing = getTicket(Number(req.params.id))
    if (!existing) return reply.code(404).send({ error: 'Request not found.' })
    // Only the assigned owner (or an admin) may move a request through its lifecycle.
    if (!isAdminRole(req.user.role) && existing.assignee !== req.user.name) {
      return reply.code(403).send({ error: 'Only the assigned owner or an admin can change the status.' })
    }
    const updated = setStatus(existing.id, status, req.user.name)
    // Mirror the decision back to the Data Fabric record (best-effort).
    if (updated?.dfRecordId && isOrchestratorConfigured()) {
      void dataFabricUpdate(updated.dfRecordId, updated.assignee ?? '', status)
        .then(() => app.log.info(`Ticket #${updated.id} status '${status}' mirrored to Data Fabric`))
        .catch((err) => app.log.warn(`Data Fabric write-back failed for #${updated.id}: ${(err as Error).message}`))
    }
    return updated
  })

  app.patch<{ Params: { id: string }; Body: { priority?: TicketPriority } }>('/:id/priority', async (req, reply) => {
    const priority = req.body?.priority
    if (!priority || !PRIORITIES.includes(priority)) return reply.code(400).send({ error: 'Invalid priority.' })
    const ticket = setPriority(Number(req.params.id), priority, req.user.name)
    if (!ticket) return reply.code(404).send({ error: 'Request not found.' })
    return ticket
  })

  app.patch<{ Params: { id: string }; Body: { assignee?: string | null } }>('/:id/assignee', async (req, reply) => {
    const raw = req.body?.assignee
    const assignee = raw && String(raw).trim() ? String(raw).trim() : null
    const existing = getTicket(Number(req.params.id))
    if (!existing) return reply.code(404).send({ error: 'Request not found.' })

    const admin = isAdminRole(req.user.role)
    const isCurrentAssignee = existing.assignee != null && existing.assignee === req.user.name
    // Admins assign/reassign anyone; the current assignee may hand off to a peer.
    if (!admin && !isCurrentAssignee) {
      return reply.code(403).send({ error: 'Only an admin or the current assignee can (re)assign this request.' })
    }
    if (!admin && !assignee) {
      return reply.code(403).send({ error: 'Only an admin can unassign a request.' })
    }
    // The new assignee must belong to the request's service department.
    if (assignee && !listAssignable(existing.serviceLine).some((m) => m.name === assignee)) {
      return reply.code(422).send({ error: `${assignee} is not a member of the ${existing.serviceLine} department.` })
    }
    return setAssignee(existing.id, assignee, req.user.name)
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const existing = getTicket(Number(req.params.id))
    if (!existing) return reply.code(404).send({ error: 'Request not found.' })
    // Deletion depends on role, status and assignment (see canDeleteTicket).
    if (!canDeleteTicket(existing, isAdminRole(req.user.role))) {
      return reply.code(403).send({
        error:
          existing.status === 'in_progress'
            ? 'A request that is in progress can’t be deleted.'
            : 'You don’t have permission to delete this request.',
      })
    }
    deleteTicket(existing.id)
    return reply.code(204).send()
  })

  app.post<{ Params: { id: string }; Body: { body?: string; internal?: boolean } }>(
    '/:id/comments',
    async (req, reply) => {
      const body = req.body?.body?.trim()
      if (!body) return reply.code(400).send({ error: 'Comment body is required.' })
      const ticket = addComment(Number(req.params.id), req.user.name, body, !!req.body?.internal)
      if (!ticket) return reply.code(404).send({ error: 'Request not found.' })
      // System-driven lifecycle: the assignee's first work-note on a still-pending
      // request means they've started — auto-advance it to In progress.
      if (ticket.assignee === req.user.name && ticket.status === 'pending') {
        return setStatus(ticket.id, 'in_progress', req.user.name)
      }
      return ticket
    },
  )

  app.post<{ Params: { id: string }; Body: Partial<Feedback> }>('/:id/feedback', async (req, reply) => {
    const rating = Number(req.body?.rating)
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return reply.code(400).send({ error: 'Rating must be an integer from 1 to 5.' })
    }
    const ticket = addFeedback(Number(req.params.id), {
      rating,
      comment: req.body?.comment,
      createdAt: new Date().toISOString(),
    })
    if (!ticket) return reply.code(404).send({ error: 'Request not found.' })
    return ticket
  })
}
