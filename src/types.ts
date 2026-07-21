// Domain types — kept in sync with the frontend's `src/types`. The API speaks
// camelCase JSON so responses drop straight into the client's types.

export type TicketStatus = 'open' | 'pending' | 'in_progress' | 'resolved' | 'closed' | 'declined'
export type TicketPriority = 'urgent' | 'high' | 'normal' | 'low'
export type ServiceLine =
  | 'support'
  | 'crm'
  | 'professional-services'
  | 'retail-banking'
  | 'account-opening'
  | 'corporate-banking'
  | 'investment-banking'
  | 'wealth-management'
  | 'private-banking'
  | 'payments'
  | 'card-services'
  | 'lending-mortgages'
  | 'trade-finance'
  | 'treasury-cash-management'
  | 'digital-banking'
  | 'fintech-partnerships'
  | 'risk-compliance'
  | 'fraud-prevention'
  | 'aml-kyc'
  | 'operations'
  | 'customer-service'
  | 'core-banking'
  | 'collections'
  | 'business-banking'
  | 'securities-services'
  | 'merchant-services'
  | 'other'

export type Channel =
  | 'web'
  | 'email'
  | 'chat'
  | 'phone'
  | 'api'
  | 'branch'
  | 'call_center'
  | 'ivr'
  | 'mobile_app'
  | 'online_banking'
  | 'atm'
  | 'sms'
  | 'secure_message'
  | 'swift'
  | 'live_chat'
  | 'social'
  | 'mobile_push'
  | 'video_banking'
  | 'kiosk'
  | 'chatbot'
  | 'advisor_portal'
  | 'in_person'
  | 'secure_portal'
  | 'ussd'
  | 'other'
export type ActivityKind =
  | 'created'
  | 'comment'
  | 'status'
  | 'priority'
  | 'assignment'
  | 'attachment'
  | 'feedback'

export interface Attachment {
  id: string
  name: string
  size: number
  type: string
  dataUrl: string
  ocrText?: string
  createdAt: string
}

export interface Activity {
  id: string
  kind: ActivityKind
  author: string
  body: string
  createdAt: string
  internal?: boolean
}

export interface Feedback {
  rating: number
  comment?: string
  createdAt: string
}

export interface Ticket {
  id: number
  subject: string
  description: string
  status: TicketStatus
  priority: TicketPriority
  serviceLine: ServiceLine
  channel: Channel
  requester: string
  requesterEmail: string
  accountId: string | null
  assignee: string | null
  tags: string[]
  attachments: Attachment[]
  activity: Activity[]
  feedback: Feedback | null
  /** Email of the authenticated user who logged (submitted) the request. */
  submittedBy: string | null
  /** True when the submitter logged this for a different person (the requester). */
  onBehalf: boolean
  /** Submitter opted to own the request at intake. */
  assignToMe: boolean
  createdAt: string
  updatedAt: string
  slaDueAt: string
  /** Data Fabric mirror record id (GUID) created by the UiPath insert process;
   *  null until the backend-triggered orchestration stores the record. */
  dfRecordId: string | null
  /** Organization this request maps to, by requester/submitter email domain
   *  (null when it doesn't belong to a registered org). Computed on read. */
  organization: string | null
}

export interface NewTicketInput {
  subject: string
  description: string
  priority: TicketPriority
  serviceLine: ServiceLine
  channel: Channel
  requester: string
  requesterEmail: string
  accountId?: string | null
  tags: string[]
  attachments: Attachment[]
  onBehalf?: boolean
  /** Who to assign at intake (name/email); null/omitted = unassigned. */
  assignee?: string | null
}

export type AccountTier = 'Enterprise' | 'Business' | 'Startup'

export interface Account {
  id: string
  name: string
  domain: string
  tier: AccountTier
  industry: string
  mrr: number
  healthScore: number
  createdAt: string
}

export interface Contact {
  id: string
  name: string
  email: string
  role?: string
  accountId: string
  avatarColor: string
}

/** The organization that owns this deployment. Requests are mapped to an org by
 *  matching the requester/submitter email domain. */
export interface Organization {
  id: string
  name: string
  /** Email domain that identifies the org's people, e.g. "gifsonservices". */
  domain: string
  isPrimary: boolean
  createdAt: string
}

export type UserRole = 'superadmin' | 'admin' | 'agent'

/** All assignable roles, least → most privileged. */
export const USER_ROLES: UserRole[] = ['agent', 'admin', 'superadmin']

/** admin + superadmin both get the admin surface; only superadmin manages roles. */
export const isAdminRole = (role: UserRole): boolean => role === 'admin' || role === 'superadmin'
export const canManageRoles = (role: UserRole): boolean => role === 'superadmin'

export interface AuthUser {
  name: string
  email: string
  company: string
  avatarColor: string
  role: UserRole
  /** The service department this user belongs to (drives request assignment).
   *  Null for management accounts or users onboarded before departments. */
  department: ServiceLine | null
  createdAt: string
}

export interface UserRecord extends AuthUser {
  id: string
  passwordHash: string
}

/** Public user shape for the admin user-management table (no password hash). */
export interface UserSummary extends AuthUser {
  id: string
}

export const STATUSES: TicketStatus[] = ['open', 'pending', 'in_progress', 'resolved', 'closed', 'declined']
export const PRIORITIES: TicketPriority[] = ['urgent', 'high', 'normal', 'low']
export const SERVICE_LINES: ServiceLine[] = [
  'support', 'crm', 'professional-services', 'retail-banking', 'account-opening', 'corporate-banking',
  'investment-banking', 'wealth-management', 'private-banking', 'payments', 'card-services',
  'lending-mortgages', 'trade-finance', 'treasury-cash-management', 'digital-banking',
  'fintech-partnerships', 'risk-compliance', 'fraud-prevention', 'aml-kyc', 'operations',
  'customer-service', 'core-banking', 'collections', 'business-banking', 'securities-services',
  'merchant-services', 'other',
]
export const CHANNELS: Channel[] = [
  'web', 'email', 'chat', 'phone', 'api', 'branch', 'call_center', 'ivr', 'mobile_app',
  'online_banking', 'atm', 'sms', 'secure_message', 'swift', 'live_chat', 'social', 'mobile_push',
  'video_banking', 'kiosk', 'chatbot', 'advisor_portal', 'in_person', 'secure_portal', 'ussd', 'other',
]

export const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  pending: 'Pending',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
  declined: 'Declined',
}
export const PRIORITY_LABELS: Record<TicketPriority, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
}
