import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import crypto from 'crypto';

let masterDb = null;
const projectDbs = new Map(); // Cache project databases

// ============================================================================
// MASTER DATABASE (projects.db)
// ============================================================================

export function initMasterDatabase(storagePath = './storage') {
  const dbPath = join(storagePath, 'projects.db');

  // Ensure storage directory exists
  if (!existsSync(storagePath)) {
    mkdirSync(storagePath, { recursive: true });
  }

  masterDb = new Database(dbPath);

  // Create projects table
  masterDb.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      github_owner TEXT,
      github_repo TEXT,
      github_token TEXT,
      api_key TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_api_key ON projects(api_key);
    CREATE INDEX IF NOT EXISTS idx_name ON projects(name);

    -- Orchestration tables (workflow_instances, agent_job_log, agent_job_events,
    -- agent_memory_writes) used to live here too. They moved to shared Postgres
    -- via migration 003 so worker (agents host) and API (services host) see the
    -- same rows. Leaving the legacy tables alone — they're harmless if a stale
    -- projects.db has them, but we never write there anymore.
  `);

  // Migration: add multi-project metadata columns introduced for the
  // dashboard "Projects" view. SQLite has no IF NOT EXISTS for ADD COLUMN,
  // so we sniff PRAGMA table_info first.
  const cols = new Set(masterDb.prepare("PRAGMA table_info(projects)").all().map(c => c.name));
  for (const [col, def] of [
    ['plane_project_id',     'TEXT'],
    ['plane_workspace_slug', 'TEXT'],
    ['default_branch',       'TEXT'],
    ['local_path',           'TEXT'],
    ['description',          'TEXT'],
    // widget_pii_patterns: JSON array of regex strings appended to the
    // built-in PII filters (Bearer/sk- tokens, emails, credit cards, SSN).
    // Stored on the project row so each project can opt into stricter rules
    // without redeploying. Spec: DEVPA-166 (Sécurité widget).
    ['widget_pii_patterns',  'TEXT']
  ]) {
    if (!cols.has(col)) {
      masterDb.exec(`ALTER TABLE projects ADD COLUMN ${col} ${def}`);
    }
  }

  // Captures — Franck+Shelly's triage surface. Raw thoughts become
  // conversations become Plane work items (or get dropped). The whole
  // point of this table is that dumping an idea here is frictionless;
  // promotion to Plane is a deliberate act Shelly orchestrates.
  masterDb.exec(`
    CREATE TABLE IF NOT EXISTS captures (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL,
      kind              TEXT NOT NULL DEFAULT 'idea',
      content           TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'new',
      plane_work_item_id TEXT,
      plane_sequence_id INTEGER,
      created_by        TEXT DEFAULT 'franck',
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_captures_project ON captures(project_id);
    CREATE INDEX IF NOT EXISTS idx_captures_status  ON captures(status);
    CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at DESC);

    CREATE TABLE IF NOT EXISTS capture_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_id TEXT NOT NULL,
      role       TEXT NOT NULL,        -- 'user' | 'shelly' | 'system'
      content    TEXT NOT NULL,
      metadata   TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_capmsg_capture ON capture_messages(capture_id, created_at);
  `);

  // ============================================================================
  // SIGNAL INBOX — subjects, threads, thread_messages, deploy_events
  // ============================================================================
  masterDb.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      subject_type     TEXT NOT NULL,
      subject_id       TEXT NOT NULL,
      project_id       TEXT NOT NULL,
      title            TEXT,
      priority         TEXT,
      priority_set_at  DATETIME,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (subject_type, subject_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS subjects_priority ON subjects(priority) WHERE priority IS NOT NULL;
    CREATE INDEX IF NOT EXISTS subjects_project  ON subjects(project_id);

    CREATE TABLE IF NOT EXISTS threads (
      thread_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type     TEXT NOT NULL,
      subject_id       TEXT NOT NULL,
      project_id       TEXT NOT NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_message_at  DATETIME,
      UNIQUE (subject_type, subject_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS thread_messages (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id             INTEGER NOT NULL,
      role                  TEXT NOT NULL,
      source                TEXT NOT NULL,
      content               TEXT NOT NULL,
      telegram_message_id   INTEGER,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS thread_messages_thread ON thread_messages(thread_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS thread_messages_tg_dedup
      ON thread_messages(telegram_message_id)
      WHERE telegram_message_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS telegram_drops (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_text             TEXT NOT NULL,
      role                 TEXT,
      telegram_message_id  INTEGER,
      reason               TEXT NOT NULL DEFAULT 'no_tag',
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS telegram_drops_recent ON telegram_drops(created_at DESC);

    CREATE TABLE IF NOT EXISTS telegram_outbound (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_message_id    INTEGER,
      subject_type         TEXT,
      subject_id           TEXT,
      text                 TEXT NOT NULL,
      transport            TEXT NOT NULL,
      status               TEXT NOT NULL,
      error                TEXT,
      attempts             INTEGER NOT NULL DEFAULT 0,
      created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
      delivered_at         DATETIME
    );
    CREATE INDEX IF NOT EXISTS telegram_outbound_recent ON telegram_outbound(created_at DESC);
    CREATE INDEX IF NOT EXISTS telegram_outbound_status ON telegram_outbound(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS deploy_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT NOT NULL,
      status        TEXT NOT NULL,
      sha           TEXT,
      ref           TEXT,
      log_url       TEXT,
      failed_reason TEXT,
      started_at    DATETIME,
      finished_at   DATETIME,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS deploy_events_project_created ON deploy_events(project_id, created_at DESC);

    -- Boss-COS audit trail. Every reversible decision Shelly takes without
    -- asking lands here so Franck can see what she did overnight and roll
    -- back any of it with one click. Source of truth for the
    -- AutoDecisionsPanel in the dashboard chat. (DEVPA — boss-COS cycle.)
    CREATE TABLE IF NOT EXISTS auto_decisions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      TEXT,                            -- nullable, some decisions are studio-wide
      kind            TEXT NOT NULL,                   -- drop_capture | dispatch_nightly | restart_service | promote | misc
      what            TEXT NOT NULL,                   -- one-sentence human description ("Dropped capture 47 — duplicate of ZENO-38")
      why             TEXT,                            -- short reason, optional
      undo_hint       TEXT,                            -- machine-readable hint for rollback ({"target":"capture/47","action":"set_status","value":"new"})
      ts              DATETIME DEFAULT CURRENT_TIMESTAMP,
      rolled_back_at  DATETIME,
      rolled_back_by  TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS auto_decisions_recent ON auto_decisions(ts DESC);
    CREATE INDEX IF NOT EXISTS auto_decisions_project ON auto_decisions(project_id, ts DESC);

    -- Universal subject graph. The studio's data lives in 11+ silos
    -- (captures, plane work items, plane pages, AFFiNE docs, GitHub PRs +
    -- commits, GlitchTip issues, fleet jobs, threads, memories, deploys).
    -- subject_links is the typed-edge join table that lets Shelly traverse
    -- between them without re-stitching by hand on every query.
    --
    -- Subject types (canonical): capture | work_item | plane_page |
    --   affine_doc | pr | commit | glitchtip_issue | fleet_job | thread |
    --   memory | auto_decision | deploy.
    -- Subject ids: opaque strings. UUIDs for capture/work_item/etc.;
    --   "<owner>/<repo>#<number>" for pr; "<owner>/<repo>@<sha>" for commit;
    --   "<workspace>/<doc-id>" for affine_doc; numeric for fleet_job /
    --   glitchtip_issue / memory / auto_decision / thread.
    --
    -- Edge rel (the verb): promoted_to | reports | fixed_by | implements |
    --   ran_as | merged_as | documented_in | references | blocks | duplicate_of |
    --   regressed_by | retroed_in | decided_in.
    --
    -- All edges are directed but the unified-map query reads both ways.
    -- Idempotency via UNIQUE(from,to,rel) — the auto-population webhooks
    -- can fire many times for the same fact without piling up duplicates.
    CREATE TABLE IF NOT EXISTS subject_links (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_type   TEXT NOT NULL,
      from_id     TEXT NOT NULL,
      to_type     TEXT NOT NULL,
      to_id       TEXT NOT NULL,
      rel         TEXT NOT NULL,
      source      TEXT,                        -- 'shelly' | 'webhook' | 'manual' | 'agent' | 'auto'
      meta        TEXT,                        -- JSON sidecar for free-form context
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(from_type, from_id, to_type, to_id, rel)
    );
    CREATE INDEX IF NOT EXISTS subject_links_from ON subject_links(from_type, from_id);
    CREATE INDEX IF NOT EXISTS subject_links_to ON subject_links(to_type, to_id);
    CREATE INDEX IF NOT EXISTS subject_links_rel ON subject_links(rel, created_at DESC);

    -- Widget chat sessions — one row per browser-tab conversation surfaced
    -- through the embedded DevPanel widget. session_token is the opaque
    -- handle the widget passes back; thread_id binds the session to its
    -- subject thread (FK left unenforced because thread_id is created
    -- lazily by the widget API). Spec: DEVPA-157 § 5.1.
    CREATE TABLE IF NOT EXISTS widget_sessions (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL,
      session_token  TEXT NOT NULL UNIQUE,
      thread_id      INTEGER,
      user_agent     TEXT,
      route          TEXT,
      viewport_w     INTEGER,
      viewport_h     INTEGER,
      locale         TEXT,
      started_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen_at   DATETIME,
      closed_at      DATETIME,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_widget_sessions_project   ON widget_sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_widget_sessions_last_seen ON widget_sessions(last_seen_at DESC);

    -- widget_audit — append-only audit log for the widget surface.
    -- Stores SHA-256 hashes of message content (never plaintext) so a
    -- post-incident investigator can confirm a known message reached the
    -- server without exposing PII at rest. Type ∈ {message_in, message_out,
    -- capture_created, rate_limited, redacted}. Spec: DEVPA-166.
    CREATE TABLE IF NOT EXISTS widget_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    TEXT,
      session_id    TEXT,
      type          TEXT NOT NULL,
      content_hash  TEXT,
      ts            DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS widget_audit_project_type_ts
      ON widget_audit(project_id, type, ts DESC);

    -- MCP Servers — allows dynamically adding remote MCP toolsets (like Google
    -- Stitch) via the dashboard UI. Stored in masterDb so they're available
    -- to all threads. headers is JSON-stringified object (e.g. {"X-Goog-Api-Key": "..."}).
    CREATE TABLE IF NOT EXISTS mcp_servers (
      name        TEXT PRIMARY KEY,
      url         TEXT NOT NULL,
      headers     TEXT,
      enabled     INTEGER DEFAULT 1,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Bearer-auth columns added by DEVPA-161. The original v7 (DEVPA-160)
  // shipped widget_sessions without `session_id` / `token_expires_at`; the
  // widget API needs both for sliding 24h bearer auth, so back-fill them
  // here with column-existence guards (idempotent on fresh DBs and on DBs
  // already at v7 from DEVPA-160).
  const widgetCols = new Set(
    masterDb.prepare("PRAGMA table_info(widget_sessions)").all().map(c => c.name)
  );
  if (!widgetCols.has('session_id')) {
    masterDb.exec(`ALTER TABLE widget_sessions ADD COLUMN session_id TEXT`);
    masterDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_widget_sessions_session ON widget_sessions(session_id)`);
  }
  if (!widgetCols.has('token_expires_at')) {
    masterDb.exec(`ALTER TABLE widget_sessions ADD COLUMN token_expires_at DATETIME`);
  }


  // Migration: move capture_messages into thread_messages + drop the old table.
  // Guarded by PRAGMA user_version — runs exactly once per database.
  // Spec: docs/superpowers/specs/2026-04-22-captures-on-threads-design.md
  const CAPTURES_ON_THREADS_VERSION = 1;
  const currentVersion1 = masterDb.pragma('user_version', { simple: true });
  if (currentVersion1 < CAPTURES_ON_THREADS_VERSION) {
    const captureMessagesTable = masterDb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='capture_messages'`
    ).get();

    const migrate = masterDb.transaction(() => {
      if (captureMessagesTable) {
        // 1. Subjects: one row per existing capture.
        masterDb.prepare(`
          INSERT OR IGNORE INTO subjects (subject_type, subject_id, project_id, title)
          SELECT 'capture', id, project_id, substr(content, 1, 120) FROM captures
        `).run();

        // 2. Threads: one row per existing capture.
        masterDb.prepare(`
          INSERT OR IGNORE INTO threads (subject_type, subject_id, project_id)
          SELECT 'capture', id, project_id FROM captures
        `).run();

        // 3. Messages: copy every capture_messages row into thread_messages
        //    with source='web' (all pre-migration messages came from the dashboard).
        masterDb.prepare(`
          INSERT INTO thread_messages (thread_id, role, source, content, created_at)
          SELECT t.thread_id, cm.role, 'web', cm.content, cm.created_at
            FROM capture_messages cm
            JOIN threads t
              ON t.subject_type='capture' AND t.subject_id=cm.capture_id
           ORDER BY cm.id ASC
        `).run();

        // 4. Drop the old table.
        masterDb.exec(`DROP TABLE capture_messages`);
      }
      // 5. Bump version — always, even if there was nothing to migrate
      //    (fresh DB).
      masterDb.pragma(`user_version = ${CAPTURES_ON_THREADS_VERSION}`);
    });
    migrate();
  }

  // Migration v2: add nullable metadata column to thread_messages so the React
  // widget can attach screenshot / console / network context to capture messages.
  // Uses ALTER TABLE (not wrapped in a JS transaction — ALTER TABLE + transactions
  // can be fragile in some SQLite/better-sqlite3 combos). The column-existence
  // guard makes this idempotent.
  const currentVersion2 = masterDb.pragma('user_version', { simple: true });
  if (currentVersion2 < 2) {
    const tmCols = new Set(masterDb.prepare("PRAGMA table_info(thread_messages)").all().map(c => c.name));
    if (!tmCols.has('metadata')) {
      masterDb.exec(`ALTER TABLE thread_messages ADD COLUMN metadata TEXT`);
    }
    masterDb.pragma(`user_version = 2`);
  }

  // Migration v3: reporter identity on captures.
  // Four nullable columns + two indexes. Splits the common fields (id/name/email)
  // into columns for filtering, keeps any extra host-provided fields as JSON
  // in reporter_extra. Guarded by user_version. See spec:
  // docs/superpowers/specs/2026-04-24-widget-reporter-identity-design.md
  const REPORTER_IDENTITY_VERSION = 3;
  const currentVersion3 = masterDb.pragma('user_version', { simple: true });
  if (currentVersion3 < REPORTER_IDENTITY_VERSION) {
    const capCols = new Set(masterDb.prepare("PRAGMA table_info(captures)").all().map(c => c.name));
    if (!capCols.has('reporter_id'))    masterDb.exec(`ALTER TABLE captures ADD COLUMN reporter_id TEXT`);
    if (!capCols.has('reporter_name'))  masterDb.exec(`ALTER TABLE captures ADD COLUMN reporter_name TEXT`);
    if (!capCols.has('reporter_email')) masterDb.exec(`ALTER TABLE captures ADD COLUMN reporter_email TEXT`);
    if (!capCols.has('reporter_extra')) masterDb.exec(`ALTER TABLE captures ADD COLUMN reporter_extra TEXT`);
    masterDb.exec(`CREATE INDEX IF NOT EXISTS idx_captures_reporter_id    ON captures(reporter_id)`);
    masterDb.exec(`CREATE INDEX IF NOT EXISTS idx_captures_reporter_email ON captures(reporter_email)`);
    masterDb.pragma(`user_version = ${REPORTER_IDENTITY_VERSION}`);
  }

  // Migration v4: environment tag on captures.
  // Single nullable TEXT column + one index. Host app stamps each capture with
  // a free-form slug (dev, staging, production, preview-pr-42…). Server
  // validates slug charset in the route layer; DB just stores the string.
  // Guarded by user_version. See spec:
  // docs/superpowers/specs/2026-04-24-widget-environment-tag-design.md
  const ENVIRONMENT_TAG_VERSION = 4;
  const currentVersion4 = masterDb.pragma('user_version', { simple: true });
  if (currentVersion4 < ENVIRONMENT_TAG_VERSION) {
    const capCols4 = new Set(masterDb.prepare("PRAGMA table_info(captures)").all().map(c => c.name));
    if (!capCols4.has('environment')) masterDb.exec(`ALTER TABLE captures ADD COLUMN environment TEXT`);
    masterDb.exec(`CREATE INDEX IF NOT EXISTS idx_captures_environment ON captures(environment)`);
    masterDb.pragma(`user_version = ${ENVIRONMENT_TAG_VERSION}`);
  }

  // Migration v5: team routing columns on captures.
  // routed_label — the routing label (mirrors widget category or Shelly's choice)
  // routed_member_id — resolved Postgres member id (INTEGER, matches tickets pattern)
  // routed_at — when routing was persisted
  // Guarded by user_version. Same PRAGMA cols.has() pattern as above.
  const CAPTURE_ROUTING_VERSION = 5;
  const currentVersion5 = masterDb.pragma('user_version', { simple: true });
  if (currentVersion5 < CAPTURE_ROUTING_VERSION) {
    const capCols5 = new Set(masterDb.prepare("PRAGMA table_info(captures)").all().map(c => c.name));
    if (!capCols5.has('routed_label'))     masterDb.exec(`ALTER TABLE captures ADD COLUMN routed_label TEXT`);
    if (!capCols5.has('routed_member_id')) masterDb.exec(`ALTER TABLE captures ADD COLUMN routed_member_id INTEGER`);
    if (!capCols5.has('routed_at'))        masterDb.exec(`ALTER TABLE captures ADD COLUMN routed_at DATETIME`);
    masterDb.pragma(`user_version = ${CAPTURE_ROUTING_VERSION}`);
  }

  // Migration v6: inbox_state — per-(subject_type, subject_id) row state for
  // the typed Inbox surface. A row stops showing once the user has dismissed
  // it (handled), or until snoozed_until passes. last_seen_at is purely
  // informational (used for "X new since you last looked"). PK on
  // (subject_type, subject_id) so we can upsert idempotently.
  const INBOX_STATE_VERSION = 6;
  const currentVersion6 = masterDb.pragma('user_version', { simple: true });
  if (currentVersion6 < INBOX_STATE_VERSION) {
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS inbox_state (
        subject_type    TEXT NOT NULL,
        subject_id      TEXT NOT NULL,
        last_seen_at    DATETIME,
        snoozed_until   DATETIME,
        dismissed_at    DATETIME,
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (subject_type, subject_id)
      );
      CREATE INDEX IF NOT EXISTS inbox_state_active
        ON inbox_state(dismissed_at, snoozed_until);
    `);
    masterDb.pragma(`user_version = ${INBOX_STATE_VERSION}`);
  }

  // Migration v7: widget chat surface — widget_sessions table (created above
  // alongside the other signal-inbox tables) plus two new columns on captures
  // (source, widget_session_id) and a normalisation of thread_messages.source
  // from the legacy 'web' value to the new canonical 'dashboard'.
  // Spec: DEVPA-157 § 5.1 / 5.2 (cycle "Shelly in the Widget", DEVPA-160).
  const WIDGET_SESSIONS_VERSION = 7;
  const currentVersion7 = masterDb.pragma('user_version', { simple: true });
  if (currentVersion7 < WIDGET_SESSIONS_VERSION) {
    const capCols7 = new Set(masterDb.prepare("PRAGMA table_info(captures)").all().map(c => c.name));
    if (!capCols7.has('source')) {
      masterDb.exec(`ALTER TABLE captures ADD COLUMN source TEXT NOT NULL DEFAULT 'dashboard'`);
    }
    if (!capCols7.has('widget_session_id')) {
      masterDb.exec(
        `ALTER TABLE captures ADD COLUMN widget_session_id TEXT REFERENCES widget_sessions(id)`
      );
    }
    // Rename legacy 'web' source on thread_messages to the canonical 'dashboard'.
    // Other values ('telegram', etc.) are left untouched.
    masterDb.exec(`UPDATE thread_messages SET source = 'dashboard' WHERE source = 'web'`);
    masterDb.pragma(`user_version = ${WIDGET_SESSIONS_VERSION}`);
  }

  // Migration v8: GlitchTip bridge — auto-detected runtime errors land in the
  // captures inbox alongside widget-reported bugs, so they pass through the
  // same Shelly-triage → Plane-promotion pipeline. Spec: DEVPA-169 / Plane page
  // "Observability — error tracking (GlitchTip)" §7.
  // Three new columns: fingerprint (issue.fingerprint, used for dedup),
  // occurrence_count (incremented on repeat), external_url (permalink to the
  // GlitchTip issue). The partial unique index makes dedup atomic per project
  // — same fingerprint in two different projects is fine.
  const GLITCHTIP_VERSION = 8;
  const currentVersion8 = masterDb.pragma('user_version', { simple: true });
  if (currentVersion8 < GLITCHTIP_VERSION) {
    const capCols8 = new Set(masterDb.prepare("PRAGMA table_info(captures)").all().map(c => c.name));
    if (!capCols8.has('fingerprint')) {
      masterDb.exec(`ALTER TABLE captures ADD COLUMN fingerprint TEXT`);
    }
    if (!capCols8.has('occurrence_count')) {
      masterDb.exec(`ALTER TABLE captures ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1`);
    }
    if (!capCols8.has('external_url')) {
      masterDb.exec(`ALTER TABLE captures ADD COLUMN external_url TEXT`);
    }
    masterDb.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_captures_fingerprint_project
         ON captures(project_id, fingerprint)
         WHERE fingerprint IS NOT NULL`
    );
    masterDb.pragma(`user_version = ${GLITCHTIP_VERSION}`);
  }

  return masterDb;
}

export function getMasterDatabase() {
  if (!masterDb) {
    throw new Error('Master database not initialized. Call initMasterDatabase() first.');
  }
  return masterDb;
}

// Write a subject-graph edge directly. Idempotent via the UNIQUE constraint
// on (from, to, rel) — duplicate writes from idempotent webhooks become
// no-ops. NEVER throws — the studio's hot paths (webhooks, capability
// handlers) don't want a graph-write failure to break a real action.
// Returns { inserted: true|false, id?: number, error?: string }.
export function writeSubjectLink({ from_type, from_id, to_type, to_id, rel, source = 'auto', meta = null }) {
  if (!from_type || !from_id || !to_type || !to_id || !rel) return { inserted: false };
  try {
    const db = getMasterDatabase();
    const r = db.prepare(
      `INSERT OR IGNORE INTO subject_links (from_type, from_id, to_type, to_id, rel, source, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(from_type, String(from_id), to_type, String(to_id), rel, source, meta ? JSON.stringify(meta) : null);
    return { inserted: r.changes > 0, id: r.lastInsertRowid };
  } catch (e) {
    console.warn('[subject-graph] writeSubjectLink failed:', e.message);
    return { inserted: false, error: e.message };
  }
}

// ============================================================================
// PROJECT DATABASE (per-project tickets.db)
// ============================================================================

export function initProjectDatabase(storagePath, projectId) {
  const projectDir = join(storagePath, projectId);
  const dbPath = join(projectDir, 'tickets.db');

  // Ensure project directory exists
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Create tickets table with BLOB for screenshots
  db.exec(`
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('bug', 'feature')),
      status TEXT DEFAULT 'pending' CHECK(status IN (
        'pending',
        'published',
        'rejected',
        'closed'
      )),

      -- Raw user input
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      context TEXT,
      screenshot BLOB,                    -- Image stored as BLOB
      screenshot_mime_type TEXT,          -- e.g., 'image/png'

      -- PM review
      reviewed_at DATETIME,
      reviewed_by TEXT,
      rejection_reason TEXT,

      -- GitHub sync
      github_issue_number INTEGER,
      github_issue_url TEXT,
      github_synced_at DATETIME,
      github_status TEXT,

      -- Metadata
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT
    );
  `);

  // Migration: add team-routing columns to tickets.
  // Uses PRAGMA table_info guard so it is idempotent on existing databases.
  // Spec: docs/superpowers/plans/2026-04-25-team-routing.md — Task 5
  const ticketCols = new Set(db.prepare("PRAGMA table_info(tickets)").all().map(c => c.name));
  for (const [col, def] of [
    ['routed_label',     'TEXT'],
    ['routed_member_id', 'INTEGER'],
    ['routed_at',        'DATETIME']
  ]) {
    if (!ticketCols.has(col)) {
      db.exec(`ALTER TABLE tickets ADD COLUMN ${col} ${def}`);
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_github_issue ON tickets(github_issue_number);

    -- Milestones
    CREATE TABLE IF NOT EXISTS milestones (
      id INTEGER PRIMARY KEY,
      github_id INTEGER UNIQUE NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      state TEXT DEFAULT 'open' CHECK(state IN ('open', 'closed')),
      due_on DATETIME,
      open_issues INTEGER DEFAULT 0,
      closed_issues INTEGER DEFAULT 0,
      github_url TEXT,
      synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_milestones_state ON milestones(state);

    -- Documentation storage
    CREATE TABLE IF NOT EXISTS docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      content TEXT NOT NULL,
      sha TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);

    -- Full-text search index
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      path, content, content=docs, content_rowid=id
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, path, content) VALUES('delete', old.id, old.path, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, path, content) VALUES('delete', old.id, old.path, old.content);
      INSERT INTO docs_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
    END;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL CHECK(action IN ('created', 'published', 'rejected', 'synced', 'updated')),
      ticket_id INTEGER,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_log(created_at);
  `);

  // Thread messages per ticket
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      role TEXT NOT NULL CHECK(role IN ('user', 'agent', 'admin', 'system')),
      author TEXT,
      content TEXT NOT NULL,
      github_comment_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_messages_github ON messages(github_comment_id);
  `);

  // Migrate old clarifications into messages table
  try {
    const tickets = db.prepare(`
      SELECT id, context FROM tickets WHERE context LIKE '%clarifications%'
    `).all();
    for (const ticket of tickets) {
      const ctx = JSON.parse(ticket.context || '{}');
      if (ctx.clarifications && ctx.clarifications.length > 0) {
        const insert = db.prepare(
          'INSERT OR IGNORE INTO messages (ticket_id, role, author, content, created_at) VALUES (?, ?, ?, ?, ?)'
        );
        for (const c of ctx.clarifications) {
          insert.run(ticket.id, 'agent', 'shelly', c.question, c.asked_at || new Date().toISOString());
          if (c.answer) {
            insert.run(ticket.id, 'admin', null, c.answer, c.answered_at || new Date().toISOString());
          }
        }
      }
    }
  } catch { /* first run or no clarifications — fine */ }

  // Cache the database connection
  projectDbs.set(projectId, db);

  return db;
}

export function getProjectDatabase(storagePath, projectId) {
  // Return cached connection if exists
  if (projectDbs.has(projectId)) {
    return projectDbs.get(projectId);
  }

  // Initialize if not cached
  return initProjectDatabase(storagePath, projectId);
}

// ============================================================================
// PROJECT MANAGEMENT
// ============================================================================

export function createProject({
  name, github_owner = null, github_repo = null, github_token = null,
  plane_project_id = null, plane_workspace_slug = null,
  default_branch = null, local_path = null, description = null
}) {
  const id = crypto.randomUUID();
  const api_key = 'dp_' + crypto.randomBytes(32).toString('hex');

  const stmt = masterDb.prepare(`
    INSERT INTO projects (
      id, name, github_owner, github_repo, github_token, api_key,
      plane_project_id, plane_workspace_slug, default_branch, local_path, description
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id, name, github_owner, github_repo, github_token, api_key,
    plane_project_id, plane_workspace_slug, default_branch, local_path, description
  );

  return { id, name, api_key };
}

export function getProjectByApiKey(api_key) {
  const stmt = masterDb.prepare('SELECT * FROM projects WHERE api_key = ?');
  return stmt.get(api_key);
}

export function getProjectById(id) {
  const stmt = masterDb.prepare('SELECT * FROM projects WHERE id = ?');
  return stmt.get(id);
}

export function getProjectByName(name) {
  const stmt = masterDb.prepare('SELECT * FROM projects WHERE name = ?');
  return stmt.get(name);
}

// Used by the dispatcher to translate a Plane project_id (carried on every
// work-item job) into the local checkout path on the agents host. Without
// this, builders run in dev-panel's PROJECT_ROOT and push EDMS/Zeno commits
// onto franckbirba/dev-panel.
export function getProjectByPlaneId(plane_project_id) {
  if (!plane_project_id) return null;
  const stmt = masterDb.prepare('SELECT * FROM projects WHERE plane_project_id = ?');
  return stmt.get(plane_project_id);
}

// Used by the GitHub webhook to translate a `owner/repo` pair (the only id
// GitHub gives us on a PR event) into the projects row, so we can pass
// plane_project_id into enqueueWorkflowStart and DEVPA-180's local_path
// resolution fires. Without this, merge-coordinator dispatched from a Zeno
// or EDMS PR would skip project_root resolution and fall back to
// PROJECT_ROOT (dev-panel) — exactly the cross-repo bug DEVPA-180 closes.
export function getProjectByGithubRepo(owner, repo) {
  if (!owner || !repo) return null;
  const stmt = masterDb.prepare(
    'SELECT * FROM projects WHERE LOWER(github_owner) = LOWER(?) AND LOWER(github_repo) = LOWER(?)'
  );
  return stmt.get(owner, repo);
}

export function listProjects() {
  const stmt = masterDb.prepare(`
    SELECT id, name, description, github_owner, github_repo, api_key,
           plane_project_id, plane_workspace_slug, default_branch, local_path,
           created_at, updated_at
    FROM projects ORDER BY created_at DESC
  `);
  return stmt.all();
}

export function updateProject(id, updates) {
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  const stmt = masterDb.prepare(`
    UPDATE projects SET ${fields.join(', ')} WHERE id = ?
  `);

  return stmt.run(...values);
}

export function deleteProject(id) {
  const stmt = masterDb.prepare('DELETE FROM projects WHERE id = ?');
  return stmt.run(id);
}

// ============================================================================
// MCP SERVER OPERATIONS
// ============================================================================

export function listMcpServers(onlyEnabled = false) {
  const query = onlyEnabled 
    ? 'SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name ASC'
    : 'SELECT * FROM mcp_servers ORDER BY name ASC';
  return masterDb.prepare(query).all();
}

export function upsertMcpServer({ name, url, headers = null, enabled = 1 }) {
  const stmt = masterDb.prepare(`
    INSERT INTO mcp_servers (name, url, headers, enabled, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET
      url = excluded.url,
      headers = excluded.headers,
      enabled = excluded.enabled,
      updated_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(name, url, headers ? JSON.stringify(headers) : null, enabled);
}

export function deleteMcpServer(name) {
  return masterDb.prepare('DELETE FROM mcp_servers WHERE name = ?').run(name);
}

// ============================================================================
// TICKET OPERATIONS (per-project)
// ============================================================================

export function createTicket(storagePath, projectId, ticketData) {
  const db = getProjectDatabase(storagePath, projectId);
  const { type, title, description, context, screenshot, screenshot_mime_type, created_by } = ticketData;

  const stmt = db.prepare(`
    INSERT INTO tickets (type, title, description, context, screenshot, screenshot_mime_type, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    type,
    title,
    description,
    JSON.stringify(context || {}),
    screenshot || null,
    screenshot_mime_type || null,
    created_by
  );

  return result.lastInsertRowid;
}

export function getTicket(storagePath, projectId, ticketId) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare('SELECT * FROM tickets WHERE id = ?');
  const ticket = stmt.get(ticketId);

  if (ticket && ticket.context) {
    ticket.context = JSON.parse(ticket.context);
  }

  return ticket;
}

export function listTickets(storagePath, projectId, { status, limit = 100 } = {}) {
  const db = getProjectDatabase(storagePath, projectId);
  let query = 'SELECT id, type, status, title, description, github_issue_number, github_issue_url, created_at, created_by FROM tickets WHERE 1=1';
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(query);
  const tickets = stmt.all(...params);

  return tickets;
}

export function updateTicket(storagePath, projectId, ticketId, updates) {
  const db = getProjectDatabase(storagePath, projectId);
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }

  values.push(ticketId);

  const stmt = db.prepare(`
    UPDATE tickets SET ${fields.join(', ')} WHERE id = ?
  `);

  return stmt.run(...values);
}

export function deleteTicket(storagePath, projectId, ticketId) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare('DELETE FROM tickets WHERE id = ?');
  return stmt.run(ticketId);
}

export function setTicketRouting(storagePath, projectId, ticketId, { label, member_id }) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare(`
    UPDATE tickets
       SET routed_label = ?, routed_member_id = ?, routed_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `);
  return stmt.run(label ?? null, member_id ?? null, ticketId);
}

export function getTicketRouting(storagePath, projectId, ticketId) {
  const db = getProjectDatabase(storagePath, projectId);
  const row = db.prepare(
    'SELECT routed_label, routed_member_id, routed_at FROM tickets WHERE id = ?'
  ).get(ticketId);
  if (!row) return null;
  return row;
}

export function getStats(storagePath, projectId) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM tickets
    GROUP BY status
  `);

  const rows = stmt.all();

  const stats = {
    pending: 0,
    published: 0,
    rejected: 0,
    closed: 0,
    total: 0
  };

  rows.forEach(row => {
    stats[row.status] = row.count;
    stats.total += row.count;
  });

  return stats;
}

export function logActivity(storagePath, projectId, { action, ticketId, detail }) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare(
    'INSERT INTO activity_log (action, ticket_id, detail) VALUES (?, ?, ?)'
  );
  return stmt.run(action, ticketId || null, detail || null);
}

export function listActivity(storagePath, projectId, limit = 50) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare(
    'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?'
  );
  return stmt.all(limit);
}

// ============================================================================
// CLARIFICATIONS (per-project)
// ============================================================================

export function listPendingClarifications(storagePath, projectId) {
  const db = getProjectDatabase(storagePath, projectId);
  const tickets = db.prepare(`
    SELECT id, title, type, context FROM tickets
    WHERE context LIKE '%clarifications%'
  `).all();

  const pending = [];
  for (const ticket of tickets) {
    try {
      const ctx = JSON.parse(ticket.context || '{}');
      if (ctx.clarifications) {
        for (const c of ctx.clarifications) {
          if (!c.answer) {
            pending.push({
              ticket_id: ticket.id,
              ticket_title: ticket.title,
              ticket_type: ticket.type,
              question: c.question,
              asked_at: c.asked_at
            });
          }
        }
      }
    } catch { /* skip malformed */ }
  }

  return pending;
}

export function answerClarification(storagePath, projectId, ticketId, questionIndex, answer) {
  const db = getProjectDatabase(storagePath, projectId);
  const ticket = db.prepare('SELECT context FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return null;

  const ctx = JSON.parse(ticket.context || '{}');
  if (!ctx.clarifications || !ctx.clarifications[questionIndex]) return null;

  ctx.clarifications[questionIndex].answer = answer;
  ctx.clarifications[questionIndex].answered_at = new Date().toISOString();

  db.prepare('UPDATE tickets SET context = ? WHERE id = ?').run(JSON.stringify(ctx), ticketId);
  return ctx.clarifications[questionIndex];
}

// ============================================================================
// MESSAGES (per-ticket thread)
// ============================================================================

export function listMessages(storagePath, projectId, ticketId) {
  const db = getProjectDatabase(storagePath, projectId);
  return db.prepare(
    'SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at ASC'
  ).all(ticketId);
}

export function addMessage(storagePath, projectId, ticketId, { role, author, content, github_comment_id }) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare(
    'INSERT INTO messages (ticket_id, role, author, content, github_comment_id) VALUES (?, ?, ?, ?, ?)'
  );
  const result = stmt.run(ticketId, role, author || null, content, github_comment_id || null);
  return {
    id: result.lastInsertRowid,
    ticket_id: ticketId,
    role,
    author,
    content,
    github_comment_id: github_comment_id || null,
    created_at: new Date().toISOString()
  };
}

export function getMessageByGithubCommentId(storagePath, projectId, commentId) {
  const db = getProjectDatabase(storagePath, projectId);
  return db.prepare('SELECT * FROM messages WHERE github_comment_id = ?').get(commentId);
}

// ============================================================================
// MILESTONES (per-project)
// ============================================================================

export function upsertMilestone(storagePath, projectId, milestone) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare(`
    INSERT INTO milestones (github_id, title, description, state, due_on, open_issues, closed_issues, github_url, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(github_id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      state = excluded.state,
      due_on = excluded.due_on,
      open_issues = excluded.open_issues,
      closed_issues = excluded.closed_issues,
      github_url = excluded.github_url,
      synced_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(
    milestone.github_id, milestone.title, milestone.description || null,
    milestone.state, milestone.due_on || null,
    milestone.open_issues || 0, milestone.closed_issues || 0,
    milestone.github_url || null
  );
}

export function listMilestones(storagePath, projectId, { state } = {}) {
  const db = getProjectDatabase(storagePath, projectId);
  let query = 'SELECT * FROM milestones';
  const params = [];
  if (state) {
    query += ' WHERE state = ?';
    params.push(state);
  }
  query += ' ORDER BY due_on ASC NULLS LAST';
  return db.prepare(query).all(...params);
}

// ============================================================================
// DOCUMENTATION (per-project)
// ============================================================================

export function upsertDoc(storagePath, projectId, { path, content, sha }) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare(`
    INSERT INTO docs (path, content, sha, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(path) DO UPDATE SET
      content = excluded.content,
      sha = excluded.sha,
      updated_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(path, content, sha);
}

export function getDoc(storagePath, projectId, path) {
  const db = getProjectDatabase(storagePath, projectId);
  return db.prepare('SELECT * FROM docs WHERE path = ?').get(path);
}

export function listDocs(storagePath, projectId) {
  const db = getProjectDatabase(storagePath, projectId);
  return db.prepare('SELECT id, path, sha, updated_at FROM docs ORDER BY path').all();
}

export function searchDocs(storagePath, projectId, query, limit = 10) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare(`
    SELECT d.id, d.path, d.updated_at,
           snippet(docs_fts, 1, '>>>', '<<<', '...', 64) as snippet,
           rank
    FROM docs_fts
    JOIN docs d ON d.id = docs_fts.rowid
    WHERE docs_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  return stmt.all(query, limit);
}

export function deleteDoc(storagePath, projectId, path) {
  const db = getProjectDatabase(storagePath, projectId);
  return db.prepare('DELETE FROM docs WHERE path = ?').run(path);
}

export function getDocStats(storagePath, projectId) {
  const db = getProjectDatabase(storagePath, projectId);
  return db.prepare('SELECT COUNT(*) as count FROM docs').get();
}

// ============================================================================
// UTILITIES
// ============================================================================

export function closeAllDatabases() {
  if (masterDb) {
    masterDb.close();
    masterDb = null;
  }

  for (const db of projectDbs.values()) {
    db.close();
  }

  projectDbs.clear();
}
