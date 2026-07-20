import type { Account, AccountTier, Contact } from './types'

/**
 * Power Apps Dataverse is the PRIMARY source of truth for CRM accounts &
 * contacts. When it's reachable we serve live records straight from the org;
 * when it isn't (unconfigured, token failure, network, non-2xx) the caller
 * falls back to the seeded SQLite copy so the CRM never goes dark.
 *
 * Auth is OAuth2 client-credentials against Azure AD (Entra ID). We cache the
 * bearer token in memory and refresh it lazily — 60s before its real expiry —
 * mirroring the Postman pre-request script the integration was designed from.
 * Nothing here fabricates credentials: with DATAVERSE_* unset this module is a
 * no-op and returns null so the app runs fine locally.
 *
 * Required env:
 *   DATAVERSE_TENANT_ID     Azure AD (Entra) tenant / directory id
 *   DATAVERSE_CLIENT_ID     app registration client id
 *   DATAVERSE_CLIENT_SECRET app registration client secret value
 *   DATAVERSE_BASE_URL      e.g. https://orgxxxx.crm4.dynamics.com
 *   DATAVERSE_API_VERSION   default "v9.2"
 */

interface DataverseEnv {
  tenantId: string
  clientId: string
  clientSecret: string
  baseUrl: string
  apiVersion: string
}

function readEnv(): DataverseEnv | null {
  const {
    DATAVERSE_TENANT_ID,
    DATAVERSE_CLIENT_ID,
    DATAVERSE_CLIENT_SECRET,
    DATAVERSE_BASE_URL,
    DATAVERSE_API_VERSION,
  } = process.env
  if (!DATAVERSE_TENANT_ID || !DATAVERSE_CLIENT_ID || !DATAVERSE_CLIENT_SECRET || !DATAVERSE_BASE_URL) {
    return null
  }
  return {
    tenantId: DATAVERSE_TENANT_ID,
    clientId: DATAVERSE_CLIENT_ID,
    clientSecret: DATAVERSE_CLIENT_SECRET,
    baseUrl: DATAVERSE_BASE_URL.replace(/\/$/, ''),
    apiVersion: DATAVERSE_API_VERSION ?? 'v9.2',
  }
}

export function isDataverseConfigured(): boolean {
  return readEnv() !== null
}

/* -------------------------------------------------------------- token cache */

// Cached token + the epoch-ms it expires (already skewed 60s early). A single
// in-flight promise dedupes concurrent refreshes so a burst of requests only
// mints one token — the server-side equivalent of the Postman "still valid,
// skipping token fetch" guard.
let cachedToken: string | null = null
let tokenExpiry = 0
let inFlight: Promise<string> | null = null

async function fetchToken(env: DataverseEnv): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${env.tenantId}/oauth2/v2.0/token`
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.clientId,
      client_secret: env.clientSecret,
      scope: `${env.baseUrl}/.default`,
      grant_type: 'client_credentials',
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Dataverse token failed (${res.status}) ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = data.access_token
  // Refresh 60s before the real expiry, exactly like the reference script.
  tokenExpiry = Date.now() + data.expires_in * 1000 - 60_000
  return cachedToken
}

async function getToken(env: DataverseEnv): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken
  // Collapse concurrent refreshes onto one request.
  if (!inFlight) {
    inFlight = fetchToken(env).finally(() => {
      inFlight = null
    })
  }
  return inFlight
}

/* ------------------------------------------------------------------ helpers */

// Deterministic avatar color so a given contact keeps the same swatch across
// reloads (Dataverse has no such field). Same palette the seed data uses.
const AVATAR = ['#2f6bff', '#0f8a5f', '#a97bff', '#c4820b', '#d64a41', '#1f9d63']
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
function colorFor(seed: string): string {
  return AVATAR[hash(seed) % AVATAR.length]
}

// Best-effort domain from a website URL or email — our Account model wants a
// bare host (e.g. "contoso.com").
function domainOf(website?: string | null, email?: string | null): string {
  if (website) {
    try {
      const url = website.includes('://') ? website : `https://${website}`
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      /* fall through */
    }
  }
  if (email && email.includes('@')) return email.split('@')[1]
  return ''
}

// The org's tier lives in cr226_customertypecode as "tier1"/"tier2"/"tier3"
// (case-insensitive). Map to our AccountTier; fall back to an mrr bucket when
// the value is missing or unrecognized.
function tierOf(customerType?: string | null, mrr?: number | null): AccountTier {
  switch ((customerType ?? '').trim().toLowerCase()) {
    case 'tier1':
      return 'Enterprise'
    case 'tier2':
      return 'Business'
    case 'tier3':
      return 'Startup'
  }
  if (mrr == null) return 'Business'
  if (mrr >= 20_000) return 'Enterprise'
  if (mrr >= 2_000) return 'Business'
  return 'Startup'
}

const ODATA_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  'OData-MaxVersion': '4.0',
  'OData-Version': '4.0',
})

/* ------------------------------------------------------------------ accounts */

// This org keeps its CRM data in custom cr226_ columns rather than the standard
// account/contact fields, so the mappings below read those directly.
interface DvAccount {
  accountid: string
  cr226_name?: string | null
  cr226_websiteurl?: string | null
  cr226_industrycode?: string | null
  cr226_customertypecode?: string | null
  cr226_mrr?: number | null
  cr226_health_score?: number | null
  createdon?: string | null
  [k: string]: unknown
}

/**
 * Fetch accounts from Dataverse mapped to our Account shape. Returns null when
 * Dataverse isn't configured (so callers fall back silently); throws on a real
 * failure so callers can log it before falling back.
 */
export async function fetchAccounts(): Promise<Account[] | null> {
  const env = readEnv()
  if (!env) return null

  const token = await getToken(env)
  const select =
    'accountid,cr226_name,cr226_websiteurl,cr226_industrycode,cr226_customertypecode,cr226_mrr,cr226_health_score,createdon'
  const url = `${env.baseUrl}/api/data/${env.apiVersion}/accounts?$select=${select}`
  const res = await fetch(url, { headers: ODATA_HEADERS(token) })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Dataverse accounts failed (${res.status}) ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as { value: DvAccount[] }
  return data.value.map((r) => ({
    id: r.accountid,
    name: r.cr226_name ?? '(unnamed account)',
    domain: domainOf(r.cr226_websiteurl),
    tier: tierOf(r.cr226_customertypecode, r.cr226_mrr),
    industry: r.cr226_industrycode ?? '—',
    mrr: r.cr226_mrr ?? 0,
    healthScore: r.cr226_health_score ?? 0,
    createdAt: r.createdon ?? new Date(0).toISOString(),
  }))
}

/* ------------------------------------------------------------------ contacts */

interface DvContact {
  contactid: string
  cr226_fullname?: string | null
  cr226_emailaddress?: string | null
  jobtitle?: string | null
  // Standard account lookups — either may hold the parent account.
  _parentcustomerid_value?: string | null
  _accountid_value?: string | null
  [k: string]: unknown
}

export async function fetchContacts(): Promise<Contact[] | null> {
  const env = readEnv()
  if (!env) return null

  const token = await getToken(env)
  const select = 'contactid,cr226_fullname,cr226_emailaddress,jobtitle,_parentcustomerid_value,_accountid_value'
  const url = `${env.baseUrl}/api/data/${env.apiVersion}/contacts?$select=${select}`
  const res = await fetch(url, { headers: ODATA_HEADERS(token) })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Dataverse contacts failed (${res.status}) ${detail.slice(0, 200)}`)
  }
  const data = (await res.json()) as { value: DvContact[] }
  return data.value.map((r) => ({
    id: r.contactid,
    name: r.cr226_fullname ?? '(unnamed contact)',
    email: r.cr226_emailaddress ?? '',
    role: r.jobtitle ?? undefined,
    accountId: r._parentcustomerid_value ?? r._accountid_value ?? '',
    avatarColor: colorFor(r.contactid),
  }))
}
