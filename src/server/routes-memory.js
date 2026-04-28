// src/server/routes-memory.js
// Memory surface API — proxies pgvector memories table.
import express from 'express';
import { memoryList, memorySearchSql, memoryInsert, pool } from './pg.js';
import { embed } from './voyage.js';

const NAMESPACE = 'dev-panel';
const BRIEF_TTL_MS = 5 * 60 * 1000;
const briefCache = new Map();

export function defineMemoryRoutes(router, { authenticateAdmin }) {
  // GET /memories — list or search
  router.get('/memories', authenticateAdmin, async (req, res) => {
    try {
      const { q, kind, agent, module_id, limit } = req.query;
      const opts = {
        namespace: NAMESPACE,
        kind: kind || null,
        agent: agent || null,
        module_id: module_id || null,
        limit: Math.min(parseInt(limit) || 50, 200),
      };

      if (q) {
        const embedding = await embed(q, { inputType: 'query' });
        const rows = await memorySearchSql({ ...opts, embedding });
        return res.json(rows);
      }

      const rows = await memoryList(opts);
      res.json(rows);
    } catch (e) {
      console.error('[routes-memory] GET /memories error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /memories/brief?q= — Claude synthesis cached 5min
  router.get('/memories/brief', authenticateAdmin, async (req, res) => {
    try {
      const { q } = req.query;
      if (!q) return res.status(400).json({ error: 'q parameter required' });

      const cacheKey = q.trim().toLowerCase();
      const cached = briefCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < BRIEF_TTL_MS) {
        return res.json({ brief: cached.brief, cached: true });
      }

      // Search for relevant memories
      const embedding = await embed(q, { inputType: 'query' });
      const memories = await memorySearchSql({
        namespace: NAMESPACE,
        embedding,
        limit: 10,
      });

      if (memories.length === 0) {
        return res.json({ brief: 'No memories found.', cached: false });
      }

      // Synthesize with Claude
      const memoryText = memories
        .map((m, i) => `[${i + 1}] (${m.kind}) ${m.title}\n${m.content}`)
        .join('\n\n');

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return res.json({
          brief: memories.map(m => `• ${m.title}: ${m.content}`).join('\n'),
          cached: false,
          note: 'ANTHROPIC_API_KEY not set — raw list returned',
        });
      }

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 512,
          messages: [{
            role: 'user',
            content: `You are a studio memory assistant. Synthesize these memory entries about "${q}" into a brief (3-5 sentences max). Be specific, mention work-item IDs and dates when available. No preamble.\n\n${memoryText}`,
          }],
        }),
      });

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        throw new Error(`Claude API error: ${resp.status} ${errBody.slice(0, 200)}`);
      }

      const msg = await resp.json();
      const brief = msg.content?.[0]?.text || 'Unable to synthesize.';
      briefCache.set(cacheKey, { brief, ts: Date.now() });

      // Evict old cache entries
      for (const [k, v] of briefCache) {
        if (Date.now() - v.ts > BRIEF_TTL_MS) briefCache.delete(k);
      }

      res.json({ brief, cached: false });
    } catch (e) {
      console.error('[routes-memory] GET /memories/brief error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /memories — write a new memory
  router.post('/memories', authenticateAdmin, async (req, res) => {
    try {
      const { kind, title, content, module_id, cycle_id, work_item_id, tags, agent } = req.body;
      if (!kind || !title || !content) {
        return res.status(400).json({ error: 'kind, title, and content are required' });
      }

      const validKinds = ['decision', 'debug_finding', 'handoff', 'retrospective', 'spec_note'];
      if (!validKinds.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of: ${validKinds.join(', ')}` });
      }

      const embedding = await embed(`${title}\n${content}`);
      const id = await memoryInsert({
        namespace: NAMESPACE,
        agent: agent || 'dashboard',
        kind,
        title,
        content,
        module_id: module_id || null,
        cycle_id: cycle_id || null,
        work_item_id: work_item_id || null,
        tags: tags || [],
        embedding,
      });

      res.status(201).json({ id });
    } catch (e) {
      console.error('[routes-memory] POST /memories error:', e);
      res.status(500).json({ error: e.message });
    }
  });
}
