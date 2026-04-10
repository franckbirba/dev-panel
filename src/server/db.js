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
  `);

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

export function createProject({ name, github_owner, github_repo, github_token }) {
  const id = crypto.randomUUID();
  const api_key = 'dp_' + crypto.randomBytes(32).toString('hex');

  const stmt = masterDb.prepare(`
    INSERT INTO projects (id, name, github_owner, github_repo, github_token, api_key)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, name, github_owner, github_repo, github_token, api_key);

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
  const stmt = masterDb.prepare('SELECT id, name, github_owner, github_repo, api_key, created_at FROM projects ORDER BY created_at DESC');
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
