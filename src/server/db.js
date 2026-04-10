import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

let db = null;

export function initDatabase(storagePath = './storage') {
  const dbPath = join(storagePath, 'tickets.db');

  // Ensure storage directory exists
  if (!existsSync(storagePath)) {
    mkdirSync(storagePath, { recursive: true });
  }

  // Ensure uploads directory exists
  const uploadsPath = join(storagePath, 'uploads');
  if (!existsSync(uploadsPath)) {
    mkdirSync(uploadsPath, { recursive: true });
  }

  db = new Database(dbPath);

  // Create tickets table
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
      screenshot_path TEXT,

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
      created_by TEXT,
      project TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_github_issue ON tickets(github_issue_number);
    CREATE INDEX IF NOT EXISTS idx_project ON tickets(project);
  `);

  return db;
}

export function getDatabase() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

// CRUD operations
export function createTicket({ type, title, description, context, screenshot_path, created_by, project }) {
  const stmt = db.prepare(`
    INSERT INTO tickets (type, title, description, context, screenshot_path, created_by, project)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    type,
    title,
    description,
    JSON.stringify(context || {}),
    screenshot_path,
    created_by,
    project
  );

  return result.lastInsertRowid;
}

export function getTicket(id) {
  const stmt = db.prepare('SELECT * FROM tickets WHERE id = ?');
  const ticket = stmt.get(id);

  if (ticket && ticket.context) {
    ticket.context = JSON.parse(ticket.context);
  }

  return ticket;
}

export function listTickets({ status, project, limit = 100 } = {}) {
  let query = 'SELECT * FROM tickets WHERE 1=1';
  const params = [];

  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }

  if (project) {
    query += ' AND project = ?';
    params.push(project);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(query);
  const tickets = stmt.all(...params);

  return tickets.map(ticket => {
    if (ticket.context) {
      ticket.context = JSON.parse(ticket.context);
    }
    return ticket;
  });
}

export function updateTicket(id, updates) {
  const fields = [];
  const values = [];

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }

  values.push(id);

  const stmt = db.prepare(`
    UPDATE tickets SET ${fields.join(', ')} WHERE id = ?
  `);

  return stmt.run(...values);
}

export function deleteTicket(id) {
  const stmt = db.prepare('DELETE FROM tickets WHERE id = ?');
  return stmt.run(id);
}

export function getStats(project) {
  let query = `
    SELECT
      status,
      COUNT(*) as count
    FROM tickets
  `;

  const params = [];

  if (project) {
    query += ' WHERE project = ?';
    params.push(project);
  }

  query += ' GROUP BY status';

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);

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
