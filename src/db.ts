import Database from 'libsql'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.DB_PATH ?? join(here, '..', 'data', 'support-ticker.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

/** Create tables if they don't exist. Safe to run on every boot. */
export function initDb(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      domain      TEXT NOT NULL UNIQUE,
      is_primary  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id                       TEXT PRIMARY KEY,
      name                     TEXT NOT NULL,
      email                    TEXT NOT NULL UNIQUE,
      company                  TEXT NOT NULL,
      password_hash            TEXT NOT NULL,
      avatar_color             TEXT NOT NULL,
      role                     TEXT NOT NULL DEFAULT 'agent',
      email_verified           INTEGER NOT NULL DEFAULT 0,
      email_verification_token TEXT,
      department               TEXT,
      availability             TEXT NOT NULL DEFAULT 'available',
      created_at               TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      domain       TEXT NOT NULL,
      tier         TEXT NOT NULL,
      industry     TEXT NOT NULL,
      mrr          INTEGER NOT NULL,
      health_score INTEGER NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      email        TEXT NOT NULL,
      role         TEXT,
      account_id   TEXT NOT NULL REFERENCES accounts(id),
      avatar_color TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      subject        TEXT NOT NULL,
      description    TEXT NOT NULL,
      status         TEXT NOT NULL,
      priority       TEXT NOT NULL,
      service_line   TEXT NOT NULL,
      channel        TEXT NOT NULL,
      requester      TEXT NOT NULL,
      requester_email TEXT NOT NULL,
      account_id     TEXT REFERENCES accounts(id),
      assignee       TEXT,
      tags           TEXT NOT NULL DEFAULT '[]',
      submitted_by   TEXT,
      on_behalf      INTEGER NOT NULL DEFAULT 0,
      assign_to_me   INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      sla_due_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id         TEXT PRIMARY KEY,
      ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      type       TEXT NOT NULL,
      data_url   TEXT NOT NULL,
      ocr_text   TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity (
      id         TEXT PRIMARY KEY,
      ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,
      author     TEXT NOT NULL,
      body       TEXT NOT NULL,
      internal   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback (
      ticket_id  INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
      rating     INTEGER NOT NULL,
      comment    TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_activity_ticket ON activity(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_account ON contacts(account_id);
  `)

  migrate()
}

/** Idempotent column additions for databases created before a schema change. */
function migrate(): void {
  const userCols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]
  if (!userCols.some((c) => c.name === 'role')) {
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'agent'`)
  }
  if (!userCols.some((c) => c.name === 'email_verified')) {
    db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`)
  }
  if (!userCols.some((c) => c.name === 'email_verification_token')) {
    db.exec(`ALTER TABLE users ADD COLUMN email_verification_token TEXT`)
  }
  // Service department a user belongs to (a ServiceLine value); drives which
  // requests they can be assigned. Nullable — management/legacy accounts have none.
  if (!userCols.some((c) => c.name === 'department')) {
    db.exec(`ALTER TABLE users ADD COLUMN department TEXT`)
  }
  // Agent availability (available|busy|offline); drives which agents are eligible
  // for auto-assignment/escalation. Defaults to 'available' for existing users.
  if (!userCols.some((c) => c.name === 'availability')) {
    db.exec(`ALTER TABLE users ADD COLUMN availability TEXT NOT NULL DEFAULT 'available'`)
  }

  const tcols = () => db.prepare(`PRAGMA table_info(tickets)`).all() as { name: string; notnull: number }[]
  const has = (n: string) => tcols().some((c) => c.name === n)

  if (!has('submitted_by')) {
    db.exec(`ALTER TABLE tickets ADD COLUMN submitted_by TEXT`)
    // Carry over any previously-tracked creator from the earlier created_by column.
    if (has('created_by')) db.exec(`UPDATE tickets SET submitted_by = created_by WHERE submitted_by IS NULL`)
  }
  if (!has('on_behalf')) db.exec(`ALTER TABLE tickets ADD COLUMN on_behalf INTEGER NOT NULL DEFAULT 0`)
  if (!has('assign_to_me')) db.exec(`ALTER TABLE tickets ADD COLUMN assign_to_me INTEGER NOT NULL DEFAULT 0`)
  // Data Fabric record id (GUID) for the mirror row created by the UiPath
  // Helix.DataFabricInsert process — used to write status/assignee back later.
  if (!has('df_record_id')) db.exec(`ALTER TABLE tickets ADD COLUMN df_record_id TEXT`)

  // Make account_id nullable via the FK-safe rebuild procedure. IMPORTANT: never
  // `ALTER TABLE tickets RENAME` — that rewrites child-table foreign keys to the
  // temp name and corrupts them. Build a new table and swap into place instead.
  const accCol = tcols().find((c) => c.name === 'account_id')
  if (accCol && accCol.notnull === 1) {
    db.pragma('foreign_keys = OFF')
    db.transaction(() => {
      db.exec(`
        CREATE TABLE tickets_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
          priority TEXT NOT NULL, service_line TEXT NOT NULL, channel TEXT NOT NULL,
          requester TEXT NOT NULL, requester_email TEXT NOT NULL,
          account_id TEXT REFERENCES accounts(id), assignee TEXT,
          tags TEXT NOT NULL DEFAULT '[]', submitted_by TEXT,
          on_behalf INTEGER NOT NULL DEFAULT 0, assign_to_me INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sla_due_at TEXT NOT NULL
        )
      `)
      db.exec(`
        INSERT INTO tickets_new (id, subject, description, status, priority, service_line, channel, requester, requester_email, account_id, assignee, tags, submitted_by, on_behalf, assign_to_me, created_at, updated_at, sla_due_at)
        SELECT id, subject, description, status, priority, service_line, channel, requester, requester_email, account_id, assignee, tags, submitted_by, on_behalf, assign_to_me, created_at, updated_at, sla_due_at FROM tickets
      `)
      db.exec(`DROP TABLE tickets`)
      db.exec(`ALTER TABLE tickets_new RENAME TO tickets`)
    })()
    db.pragma('foreign_keys = ON')
  }

  repairChildFks()
}

/**
 * Repair child tables whose foreign key was rewritten to a now-dropped
 * `tickets_old` by an earlier faulty migration. Rebuilds each affected table
 * with a correct `REFERENCES tickets(id)` while preserving its rows.
 */
function repairChildFks(): void {
  const refsOld = (t: string) => {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(t) as
      | { sql?: string }
      | undefined
    return !!row?.sql && row.sql.includes('tickets_old')
  }
  const specs: Record<string, { cols: string; create: string }> = {
    activity: {
      cols: 'id, ticket_id, kind, author, body, internal, created_at',
      create: `CREATE TABLE activity (
        id TEXT PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL,
        internal INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      )`,
    },
    attachments: {
      cols: 'id, ticket_id, name, size, type, data_url, ocr_text, created_at',
      create: `CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        name TEXT NOT NULL, size INTEGER NOT NULL, type TEXT NOT NULL,
        data_url TEXT NOT NULL, ocr_text TEXT, created_at TEXT NOT NULL
      )`,
    },
    feedback: {
      cols: 'ticket_id, rating, comment, created_at',
      create: `CREATE TABLE feedback (
        ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL, comment TEXT, created_at TEXT NOT NULL
      )`,
    },
  }
  const targets = Object.keys(specs).filter(refsOld)
  if (targets.length === 0) return

  db.pragma('foreign_keys = OFF')
  db.transaction(() => {
    for (const t of targets) {
      const { cols, create } = specs[t]
      db.exec(`ALTER TABLE ${t} RENAME TO ${t}_old`)
      db.exec(create)
      db.exec(`INSERT INTO ${t} (${cols}) SELECT ${cols} FROM ${t}_old`)
      db.exec(`DROP TABLE ${t}_old`)
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_activity_ticket ON activity(ticket_id)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id)`)
  })()
  db.pragma('foreign_keys = ON')
}
