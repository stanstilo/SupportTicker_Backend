import type { Ticket } from './types'

/**
 * "App-triggered" bridge to UiPath Orchestrator. When a ticket is submitted we
 * enqueue it to an Orchestrator queue; a UiPath robot (queue trigger) then
 * inserts the unassigned request into Data Fabric.
 *
 * Fully env-configured and best-effort: if the ORCH_* vars aren't set, this is
 * a no-op so the app runs fine locally. Nothing here fabricates credentials.
 *
 * Required env (UiPath Automation Cloud, external app with OR.Queues scope):
 *   ORCH_CLOUD_URL     default https://cloud.uipath.com
 *   ORCH_ORG           e.g. gifsonmate
 *   ORCH_TENANT        e.g. DefaultTenant
 *   ORCH_CLIENT_ID     external application client id
 *   ORCH_CLIENT_SECRET external application client secret
 *   ORCH_SCOPE         default "OR.Queues"
 *   ORCH_FOLDER_ID     Orchestrator folder (organization unit) id holding the queue
 *   ORCH_QUEUE_NAME    default "HelixNewTickets"
 */

interface OrchEnv {
  cloudUrl: string
  org: string
  tenant: string
  clientId: string
  clientSecret: string
  scope: string
  folderId: string
  queueName: string
}

function readEnv(): OrchEnv | null {
  const {
    ORCH_CLOUD_URL,
    ORCH_ORG,
    ORCH_TENANT,
    ORCH_CLIENT_ID,
    ORCH_CLIENT_SECRET,
    ORCH_SCOPE,
    ORCH_FOLDER_ID,
    ORCH_QUEUE_NAME,
  } = process.env
  if (!ORCH_ORG || !ORCH_TENANT || !ORCH_CLIENT_ID || !ORCH_CLIENT_SECRET || !ORCH_FOLDER_ID) {
    return null
  }
  return {
    cloudUrl: (ORCH_CLOUD_URL ?? 'https://cloud.uipath.com').replace(/\/$/, ''),
    org: ORCH_ORG,
    tenant: ORCH_TENANT,
    clientId: ORCH_CLIENT_ID,
    clientSecret: ORCH_CLIENT_SECRET,
    scope: ORCH_SCOPE ?? 'OR.Queues',
    folderId: ORCH_FOLDER_ID,
    queueName: ORCH_QUEUE_NAME ?? 'HelixNewTickets',
  }
}

export function isOrchestratorConfigured(): boolean {
  return readEnv() !== null
}

async function getToken(env: OrchEnv): Promise<string> {
  const res = await fetch(`${env.cloudUrl}/identity_/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.clientId,
      client_secret: env.clientSecret,
      scope: env.scope,
    }),
  })
  if (!res.ok) throw new Error(`Orchestrator token failed (${res.status})`)
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

/**
 * Enqueue a freshly-created (unassigned) ticket. Returns true on success.
 * SpecificContent keys are what the UiPath robot reads to build the Data Fabric
 * record. `Reference = ticketId` lets the queue dedupe re-sends.
 */
export async function enqueueTicket(ticket: Ticket): Promise<boolean> {
  const env = readEnv()
  if (!env) return false

  const token = await getToken(env)
  const url = `${env.cloudUrl}/${env.org}/${env.tenant}/orchestrator_/odata/Queues/UiPathODataSvc.AddQueueItem`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-UIPATH-OrganizationUnitId': env.folderId,
    },
    body: JSON.stringify({
      itemData: {
        Name: env.queueName,
        Priority: 'Normal',
        Reference: String(ticket.id),
        SpecificContent: {
          TicketId: String(ticket.id),
          Subject: ticket.subject,
          Description: ticket.description,
          Status: ticket.status,
          Priority: ticket.priority,
          ServiceLine: ticket.serviceLine,
          Channel: ticket.channel,
          Requester: ticket.requester,
          RequesterEmail: ticket.requesterEmail,
          AccountId: ticket.accountId,
          Tags: ticket.tags.join(','),
          CreatedAt: ticket.createdAt,
          Assignee: ticket.assignee ?? '',
        },
      },
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`AddQueueItem failed (${res.status}) ${detail.slice(0, 200)}`)
  }
  return true
}
