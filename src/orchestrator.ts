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
 *   ORCH_QUEUE_NAME    default "SupportTickerNewTickets"
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
    queueName: ORCH_QUEUE_NAME ?? 'SupportTickerNewTickets',
  }
}

export function isOrchestratorConfigured(): boolean {
  return readEnv() !== null
}

async function getToken(env: OrchEnv, scopeOverride?: string): Promise<string> {
  // Authenticate the client via HTTP Basic (client_secret_basic). UiPath's
  // confidential external apps expect this; sending id/secret in the body
  // (client_secret_post) is rejected with 400 invalid_client.
  const basicAuth = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString('base64')
  const res = await fetch(`${env.cloudUrl}/identity_/connect/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: scopeOverride ?? env.scope,
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // Common cause: the client secret was truncated in .env because it contains
    // a '#' (dotenv treats it as a comment) — quote the value. The body says
    // which: invalid_client (bad id/secret) vs invalid_scope (app lacks scope).
    throw new Error(`Orchestrator token failed (${res.status}) ${detail.slice(0, 200)}`)
  }
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

/* --------------------------------------------------------------------------
 * Direct process orchestration (backend-driven).
 *
 * The backend is the system of record and can drive the UiPath processes
 * directly: start a job, wait for it, read its output arguments. This talks to
 * Orchestrator's Jobs API — which DOES accept the external app's
 * client-credentials token (unlike Data Service, which requires a robot/user
 * identity; that's why the Data Fabric reads/writes live inside the robot
 * processes, and the backend just triggers them).
 *
 * Extra env (broader OR scope needed to start jobs / read releases):
 *   ORCH_PROC_SCOPE   default "OR.Default" (must cover Jobs + Releases + Folders)
 *   ORCH_PROC_INSERT  default "Helix.DataFabricInsert"
 *   ORCH_PROC_ASSIGN  default "Helix.AssignByDepartment"
 *   ORCH_PROC_UPDATE  default "Helix.DataFabricUpdate"
 * ------------------------------------------------------------------------ */

const PROC = {
  insert: process.env.ORCH_PROC_INSERT ?? 'Helix.DataFabricInsert',
  assign: process.env.ORCH_PROC_ASSIGN ?? 'Helix.AssignByDepartment',
  update: process.env.ORCH_PROC_UPDATE ?? 'Helix.DataFabricUpdate',
}
// Optional: pin release keys directly (skips the Releases lookup, which needs
// Releases.Read on the folder). Keyed by process name.
const RELEASE_KEY_ENV: Record<string, string | undefined> = {
  [PROC.insert]: process.env.ORCH_RELEASE_INSERT,
  [PROC.assign]: process.env.ORCH_RELEASE_ASSIGN,
  [PROC.update]: process.env.ORCH_RELEASE_UPDATE,
}
const releaseKeyCache = new Map<string, string>()

function orchBase(env: OrchEnv): string {
  return `${env.cloudUrl}/${env.org}/${env.tenant}/orchestrator_`
}
function orchHeaders(env: OrchEnv, token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-UIPATH-OrganizationUnitId': env.folderId,
  }
}

/** Resolve (and cache) a process release key by its release name in the folder. */
async function resolveReleaseKey(env: OrchEnv, token: string, name: string): Promise<string> {
  const pinned = RELEASE_KEY_ENV[name]
  if (pinned) return pinned
  const cached = releaseKeyCache.get(name)
  if (cached) return cached
  const url = `${orchBase(env)}/odata/Releases?$filter=Name eq '${encodeURIComponent(name)}'&$select=Key,Name`
  const res = await fetch(url, { headers: orchHeaders(env, token) })
  if (!res.ok) throw new Error(`Releases lookup failed (${res.status}) for "${name}"`)
  const data = (await res.json()) as { value: { Key: string; Name: string }[] }
  const key = data.value?.[0]?.Key
  if (!key) throw new Error(`No release named "${name}" in folder ${env.folderId}`)
  releaseKeyCache.set(name, key)
  return key
}

/** Start a serverless job for a process, wait for it, return its OutputArguments. */
async function startJobAndWait(
  processName: string,
  inputArgs: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<Record<string, unknown>> {
  const env = readEnv()
  if (!env) throw new Error('Orchestrator not configured')
  const scope = process.env.ORCH_PROC_SCOPE ?? 'OR.Default'
  const token = await getToken(env, scope)
  const releaseKey = await resolveReleaseKey(env, token, processName)

  const startRes = await fetch(`${orchBase(env)}/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs`, {
    method: 'POST',
    headers: orchHeaders(env, token),
    body: JSON.stringify({
      startInfo: {
        ReleaseKey: releaseKey,
        Strategy: 'ModernJobsCount',
        RuntimeType: 'Serverless',
        JobsCount: 1,
        InputArguments: JSON.stringify(inputArgs),
      },
    }),
  })
  if (!startRes.ok) {
    const d = await startRes.text().catch(() => '')
    throw new Error(`StartJobs failed (${startRes.status}) ${d.slice(0, 200)}`)
  }
  const started = (await startRes.json()) as { value: { Id: number }[] }
  const jobId = started.value?.[0]?.Id
  if (!jobId) throw new Error(`StartJobs returned no job id for "${processName}"`)

  // Poll until terminal. Serverless cold-start can take ~30-45s.
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const jRes = await fetch(
      `${orchBase(env)}/odata/Jobs(${jobId})?$select=State,OutputArguments,Info`,
      { headers: orchHeaders(env, token) },
    )
    if (!jRes.ok) continue
    const job = (await jRes.json()) as { State: string; OutputArguments: string | null; Info: string | null }
    if (job.State === 'Successful') {
      return job.OutputArguments ? (JSON.parse(job.OutputArguments) as Record<string, unknown>) : {}
    }
    if (job.State === 'Faulted' || job.State === 'Stopped') {
      throw new Error(`Job "${processName}" ${job.State}: ${job.Info ?? ''}`)
    }
  }
  throw new Error(`Job "${processName}" timed out after ${timeoutMs}ms`)
}

/** Create the ticket's Data Fabric record; returns the new record id (GUID). */
export async function dataFabricInsert(ticket: Ticket): Promise<string | null> {
  const out = await startJobAndWait(PROC.insert, {
    in_Subject: ticket.subject,
    in_Description: ticket.description,
    in_ServiceLine: ticket.serviceLine,
    in_Priority: ticket.priority,
    in_Channel: ticket.channel,
    in_Account: ticket.accountId ?? '',
    in_Requester: ticket.requester,
    in_RequesterEmail: ticket.requesterEmail,
    in_Tags: ticket.tags.join(','),
    in_Status: ticket.status,
  })
  return (out.out_RecordId as string) || null
}

/** Resolve an assignee for the ticket by its service line; '' if none found. */
export async function assignByDepartment(recordId: string, serviceLine: string): Promise<string> {
  const out = await startJobAndWait(PROC.assign, { in_TicketId: recordId, in_ServiceLine: serviceLine })
  return (out.out_Assignee as string) || ''
}

/** Write status/assignee back to the ticket's Data Fabric record. */
export async function dataFabricUpdate(
  recordId: string,
  assignee: string,
  status: string,
  note = '',
): Promise<void> {
  await startJobAndWait(PROC.update, {
    in_TicketId: recordId,
    in_Assignee: assignee,
    in_Status: status,
    in_DecisionNote: note,
  })
}
