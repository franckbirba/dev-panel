// routes-memory.js
// Memory surface — exposes the pgvector `memories` table to the dashboard.
// This is the one screen no competitor can replicate: cross-project,
// cross-agent, persistent studio knowledge.
//
// Scope (Phase 4 minimal viable):
//   GET  /api/memories                 — list/text-search by query
//   GET  /api/memories/brief?q=        — concatenated recent matching memories
//                                        (Claude synthesis is a follow-up)
//   POST /api/memories                 — Franck writes a memory directly
//
// The dashboard cannot compute embeddings client-side, so semantic vector
// search (memorySearchSql) is not exposed here. Text search uses Postgres
// ILIKE on title+content+tags — fast enough at studio scale (<10k rows
// expected).

import { pool as pgPool } from './pg.js';

const NAMESPACE_DEFAULT = 'studio';

async function safeQuery(sql, params) {
  try {
    const r = await pgPool.query(sql, params);
    return { ok: true, rows: r.rows };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function defineMemoryRoutes(router, authenticateProject) {
  // GET /api/memories?q=&kind=&agent=&work_item_id=&limit=
  // q (optional): text search across title + content + tags.
  // Without q, returns most recent rows (the studio diary).
  router.get('/memories', authenticateProject, async (req, res) => {
    const q = (req.query.q || '').trim();
    const kind = req.query.kind || null;
    const agent = req.query.agent || null;
    const work_item_id = req.query.work_item_id || null;
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const params = [NAMESPACE_DEFAULT];
    const clauses = ['namespace = $1'];
    if (kind)         { params.push(kind);         clauses.push(`kind = $${params.length}`); }
    if (agent)        { params.push(agent);        clauses.push(`agent = $${params.length}`); }
    if (work_item_id) { params.push(work_item_id); clauses.push(`work_item_id = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const i = params.length;
      // Search across title / content / tags array. Tags use ILIKE on the
      // textual representation — coarse but adequate for a studio-scale set.
      clauses.push(`(title ILIKE $${i} OR content ILIKE $${i} OR array_to_string(tags, ',') ILIKE $${i})`);
    }
    params.push(limit);
    const sql = `
      SELECT id, agent, kind, title, content, module_id, cycle_id, work_item_id,
             tags, created_at
        FROM memories
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}
    `;
    const r = await safeQuery(sql, params);
    if (!r.ok) {
      // Postgres unreachable (e.g. test envs without PG) — degrade to empty
      // so the dashboard renders rather than 500ing.
      console.error('[memory] list failed:', r.error);
      return res.json({ memories: [], degraded: true, error: r.error });
    }
    res.json({ memories: r.rows });
  });

  // GET /api/memories/brief?q=
  // Returns the concatenated set of memories that mention q, ordered newest
  // first. Phase 4 deeper: pipe through a single Claude call to synthesise.
  // For now this is "show me the raw context I have on X" which is already
  // valuable — the synthesis is a render-side concern we can layer in.
  router.get('/memories/brief', authenticateProject, async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const params = [NAMESPACE_DEFAULT, `%${q}%`];
    const sql = `
      SELECT id, agent, kind, title, content, module_id, cycle_id, work_item_id,
             tags, created_at
        FROM memories
       WHERE namespace = $1
         AND (title ILIKE $2 OR content ILIKE $2 OR array_to_string(tags, ',') ILIKE $2
              OR work_item_id ILIKE $2 OR module_id ILIKE $2)
       ORDER BY created_at DESC
       LIMIT 25
    `;
    const r = await safeQuery(sql, params);
    if (!r.ok) {
      return res.json({ q, memories: [], degraded: true, error: r.error });
    }
    // Group by kind for quick scanning.
    const grouped = {};
    for (const m of r.rows) {
      grouped[m.kind] = grouped[m.kind] || [];
      grouped[m.kind].push(m);
    }
    res.json({ q, memories: r.rows, grouped, count: r.rows.length });
  });

  // POST /api/memories
  // Body: { kind, title, content, tags?, work_item_id?, module_id?, cycle_id? }
  // Inserts directly into memories without an embedding (zero-vector
  // placeholder). Means semantic search won't surface it for agents until a
  // background re-embedder rewrites the embedding column. That's fine for
  // now — Franck's writes are surfaced via text search and are visible to
  // the dashboard immediately. Backfill is a follow-up.
  router.post('/memories', authenticateProject, async (req, res) => {
    const {
      kind, title, content,
      tags = [],
      work_item_id = null, module_id = null, cycle_id = null,
    } = req.body || {};
    if (!kind || !title || !content) {
      return res.status(400).json({ error: 'kind, title, content required' });
    }
    if (typeof title !== 'string' || typeof content !== 'string') {
      return res.status(400).json({ error: 'title and content must be strings' });
    }
    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags must be an array of strings' });
    }
    // Zero vector — schema requires one. memories.embedding is vector(1024)
    // per migration 001. A backfiller can rewrite later.
    const ZERO_DIM = 1024;
    const zeroVec = '[' + new Array(ZERO_DIM).fill(0).join(',') + ']';
    try {
      const r = await pgPool.query(
        `INSERT INTO memories
           (namespace, agent, kind, module_id, cycle_id, work_item_id,
            title, content, tags, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector)
         RETURNING id, agent, kind, title, content, module_id, cycle_id,
                   work_item_id, tags, created_at`,
        [
          NAMESPACE_DEFAULT,
          'human',
          String(kind).slice(0, 32),
          module_id, cycle_id, work_item_id,
          title.slice(0, 200),
          content.slice(0, 8000),
          tags.slice(0, 20).map(t => String(t).slice(0, 32)),
          zeroVec,
        ]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) {
      console.error('[memory] insert failed:', e);
      res.status(500).json({ error: e.message });
    }
  });
}
