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

    CREATE TABLE IF NOT EXISTS agent_job_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      agent TEXT NOT NULL,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      duration_ms INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ajl_job ON agent_job_log(job_id);
    CREATE INDEX IF NOT EXISTS idx_ajl_time ON agent_job_log(timestamp DESC);

    CREATE TABLE IF NOT EXISTS agent_memory_writes (
      job_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      PRIMARY KEY (job_id, memory_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_instances (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id    TEXT NOT NULL,
      workflow_name   TEXT NOT NULL,
      revision        INTEGER NOT NULL DEFAULT 1,
      current_step    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'running',
      module_id       TEXT,
      cycle_id        TEXT,
      started_at      INTEGER NOT NULL,
      last_event_at   INTEGER NOT NULL,
      exhausted_at    INTEGER,
      last_job_id     TEXT,
      metadata        TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wi_workflow_active
      ON workflow_instances(work_item_id, workflow_name)
      WHERE status IN ('running', 'awaiting_approval');
    CREATE INDEX IF NOT EXISTS idx_wi_status ON workflow_instances(status);
    CREATE INDEX IF NOT EXISTS idx_wi_cycle  ON workflow_instances(cycle_id);
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
    ['description',          'TEXT']
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
  `);

  return masterDb;
}

export function getMasterDatabase() {
  if (!masterDb) {
    throw new Error('Master database not initialized. Call initMasterDatabase() first.');
  }
  return masterDb;
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
