// routes-inbox.js
// The typed Inbox API — Notify | Question | Review interrupts the human must
// decide on. Reads from the existing signals aggregator (deploy_events,
// captures, workflow_instances, BullMQ failed jobs) and overlays inbox_state
// so a row stops showing once it's been dismissed or snoozed.
//
// Schema returned to the dashboard:
//   { id, type, origin, subject_type, subject_id,
//     project_id, project_name, title, preview, age_seconds, created_at,
//     priority, work_item_id?, agent?, job_id?, raw }
//
// Type mapping (signal_type → InboxItem.type):
//   capture_new           → QUESTION    (Shelly + human triage)
//   capture_triaging      → QUESTION
//   workflow_exhausted    → REVIEW      (the workflow stalled, decide retry/abandon)
//   workflow_in_progress  → (suppressed — Fleet shows running work)
//   workflow_done         → NOTIFY      (FYI, dismissable)
//   deploy_failed         → NOTIFY
//   deploy_succeeded      → NOTIFY
//   bootstrap_*           → NOTIFY
//   job_failed            → REVIEW
//
// Auth: project-key (X-API-Key). Project-scoped reads only.

import { getMasterDatabase } from './db.js';
import { buildSignalsFeed } from './signals.js';

const TYPE_MAP = {
  capture_new:          'QUESTION',
  capture_triaging:     'QUESTION',
  workflow_exhausted:   'REVIEW',
  workflow_done:        'NOTIFY',
  deploy_failed:        'NOTIFY',
  deploy_succeeded:     'NOTIFY',
  bootstrap_failed:     'NOTIFY',
  bootstrap_succeeded:  'NOTIFY',
  job_failed:           'REVIEW',
};

const ORIGIN_MAP = {
  capture_new:          'capture',
  capture_triaging:     'capture',
  workflow_exhausted:   'workflow',
  workflow_done:        'workflow',
  deploy_failed:        'deploy',
  deploy_succeeded:     'deploy',
  bootstrap_failed:     'deploy',
  bootstrap_succeeded:  'deploy',
  job_failed:           'job',
};

function ageSeconds(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

// Apply inbox_state overlay: drop rows that have been dismissed or are
// currently snoozed (snoozed_until > now). last_seen_at is informational,
// doesn't filter.
function applyInboxState(rows, db) {
  if (rows.length === 0) return rows;
  const placeholders = rows.map(() => '(?, ?)').join(',');
  const params = rows.flatMap(r => [r.subject_type, r.subject_id]);
  const stateRows = db.prepare(`
    SELECT subject_type, subject_id, last_seen_at, snoozed_until, dismissed_at
      FROM inbox_state
     WHERE (subject_type, subject_id) IN (VALUES ${placeholders})
  `).all(...params);
  const stateMap = new Map();
  for (const s of stateRows) {
    stateMap.set(`${s.subject_type}/${s.subject_id}`, s);
  }
  const nowIso = new Date().toISOString();
  return rows
    .map(r => {
      const s = stateMap.get(`${r.subject_type}/${r.subject_id}`);
      return { ...r, _state: s };
    })
    .filter(r => {
      if (!r._state) return true;
      if (r._state.dismissed_at) return false;
      if (r._state.snoozed_until && r._state.snoozed_until > nowIso) return false;
      return true;
    });
}

function toInboxItem(s) {
  const type = TYPE_MAP[s.signal_type];
  if (!type) return null;
  return {
    id: `${s.subject_type}:${s.subject_id}`,
    type,
    origin: ORIGIN_MAP[s.signal_type] || 'shelly',
    subject_type: s.subject_type,
    subject_id: s.subject_id,
    project_id: s.project_id,
    project_name: s.project_name,
    title: s.title || '(untitled)',
    preview: s.title?.slice(0, 200) || null,
    age_seconds: ageSeconds(s.created_at),
    created_at: s.created_at,
    priority: s.priority || null,
    signal_type: s.signal_type,
    work_item_id: s.subject_type === 'work_item' ? s.subject_id : null,
    agent: s.raw?.agent || null,
    job_id: s.subject_type === 'job' ? s.subject_id : null,
    last_seen_at: s._state?.last_seen_at || null,
    snoozed_until: s._state?.snoozed_until || null,
  };
}

function upsertInboxState(db, subject_type, subject_id, fields) {
  const cols = Object.keys(fields);
  const vals = Object.values(fields);
  const setClause = cols.map(c => `${c} = excluded.${c}`).join(', ');
  db.prepare(`
    INSERT INTO inbox_state (subject_type, subject_id, ${cols.join(', ')}, updated_at)
    VALUES (?, ?, ${cols.map(() => '?').join(', ')}, CURRENT_TIMESTAMP)
    ON CONFLICT(subject_type, subject_id) DO UPDATE SET
      ${setClause},
      updated_at = CURRENT_TIMESTAMP
  `).run(subject_type, subject_id, ...vals);
}

export function defineInboxRoutes(router, authenticateProject) {
  // GET /api/inbox?type=NOTIFY|QUESTION|REVIEW&since_min=1440
  // Returns the typed inbox for the authenticated project, with state overlay.
  router.get('/inbox', authenticateProject, async (req, res) => {
    try {
      const project_id = req.project.id;
      const type = req.query.type || null;
      const since_min = req.query.since_min ? parseInt(req.query.since_min, 10) : 1440;

      const signals = await buildSignalsFeed({ project_id, since_min });
      const db = getMasterDatabase();
      const overlaid = applyInboxState(signals, db);

      const items = overlaid
        .map(toInboxItem)
        .filter(Boolean)
        .filter(it => !type || it.type === type);

      // Order: REVIEW (decisions blocking work) → QUESTION → NOTIFY, then newest first.
      const TYPE_ORDER = { REVIEW: 0, QUESTION: 1, NOTIFY: 2 };
      items.sort((a, b) => {
        const t = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
        if (t !== 0) return t;
        return (b.age_seconds ?? 0) < (a.age_seconds ?? 0) ? -1 : 1;
      });

      // Group counts so the sidebar/badges don't need a second roundtrip.
      const counts = {
        total: items.length,
        REVIEW: items.filter(i => i.type === 'REVIEW').length,
        QUESTION: items.filter(i => i.type === 'QUESTION').length,
        NOTIFY: items.filter(i => i.type === 'NOTIFY').length,
      };

      res.json({ items, counts });
    } catch (e) {
      console.error('[inbox] GET /inbox failed:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/inbox/:subject_type/:subject_id/seen — mark last_seen_at
  // (the row stays visible; this is the "I looked at it" hint, not a dismiss).
  router.post('/inbox/:subject_type/:subject_id/seen', authenticateProject, (req, res) => {
    const { subject_type, subject_id } = req.params;
    upsertInboxState(getMasterDatabase(), subject_type, subject_id, {
      last_seen_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // POST /api/inbox/:subject_type/:subject_id/snooze
  // Body: { minutes? } — defaults to 1440 (24h). Row disappears until then.
  router.post('/inbox/:subject_type/:subject_id/snooze', authenticateProject, (req, res) => {
    const { subject_type, subject_id } = req.params;
    const minutes = parseInt(req.body?.minutes, 10) || 1440;
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    upsertInboxState(getMasterDatabase(), subject_type, subject_id, {
      snoozed_until: until,
    });
    res.json({ ok: true, snoozed_until: until });
  });

  // POST /api/inbox/:subject_type/:subject_id/dismiss — handled, hide for good
  // (until something pushes a fresh signal that re-creates the inbox row, e.g.
  // a new failure on the same workflow).
  router.post('/inbox/:subject_type/:subject_id/dismiss', authenticateProject, (req, res) => {
    const { subject_type, subject_id } = req.params;
    upsertInboxState(getMasterDatabase(), subject_type, subject_id, {
      dismissed_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  });

  // POST /api/inbox/:subject_type/:subject_id/restore — undo dismiss/snooze.
  router.post('/inbox/:subject_type/:subject_id/restore', authenticateProject, (req, res) => {
    const { subject_type, subject_id } = req.params;
    getMasterDatabase().prepare(`
      UPDATE inbox_state
         SET dismissed_at = NULL, snoozed_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE subject_type = ? AND subject_id = ?
    `).run(subject_type, subject_id);
    res.json({ ok: true });
  });
}
