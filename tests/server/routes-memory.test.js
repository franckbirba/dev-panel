// tests/server/routes-memory.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/server/pg.js', () => ({
  pool: { query: vi.fn() },
  memoryList: vi.fn(),
  memorySearchSql: vi.fn(),
  memoryInsert: vi.fn(),
}));

vi.mock('../../src/server/voyage.js', () => ({
  embed: vi.fn().mockResolvedValue(Array(1024).fill(0.01)),
}));

const SAMPLE_MEMORIES = [
  { id: 'mem-1', agent: 'builder', kind: 'decision', title: 'Use React', content: 'Chose React for UI', tags: ['frontend'], created_at: '2026-04-20T10:00:00Z' },
  { id: 'mem-2', agent: 'shelly', kind: 'retrospective', title: 'Deploy went well', content: 'Smooth deploy', tags: [], created_at: '2026-04-21T10:00:00Z' },
];

describe('routes-memory', () => {
  let app;
  let memoryList, memorySearchSql, memoryInsert, embed;

  beforeEach(async () => {
    vi.resetModules();
    const pg = await import('../../src/server/pg.js');
    const voyage = await import('../../src/server/voyage.js');
    memoryList = pg.memoryList;
    memorySearchSql = pg.memorySearchSql;
    memoryInsert = pg.memoryInsert;
    embed = voyage.embed;

    memoryList.mockResolvedValue(SAMPLE_MEMORIES);
    memorySearchSql.mockResolvedValue(SAMPLE_MEMORIES);
    memoryInsert.mockResolvedValue('mem-new');
    embed.mockResolvedValue(Array(1024).fill(0.01));

    app = express();
    app.use(express.json());
    const router = express.Router();
    const { defineMemoryRoutes } = await import('../../src/server/routes-memory.js');
    // authenticateAdmin is a no-op in tests
    defineMemoryRoutes(router, { authenticateAdmin: (req, res, next) => next() });
    app.use('/api', router);
  });

  describe('GET /api/memories', () => {
    it('returns list of memories', async () => {
      const res = await request(app).get('/api/memories');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].id).toBe('mem-1');
      expect(memoryList).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'dev-panel' }));
    });

    it('filters by kind', async () => {
      await request(app).get('/api/memories?kind=decision');
      expect(memoryList).toHaveBeenCalledWith(expect.objectContaining({ kind: 'decision' }));
    });

    it('searches by query using embeddings', async () => {
      await request(app).get('/api/memories?q=React');
      expect(embed).toHaveBeenCalledWith('React', { inputType: 'query' });
      expect(memorySearchSql).toHaveBeenCalled();
    });

    it('respects limit param capped at 200', async () => {
      await request(app).get('/api/memories?limit=500');
      expect(memoryList).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    });
  });

  describe('GET /api/memories/brief', () => {
    it('returns 400 without q param', async () => {
      const res = await request(app).get('/api/memories/brief');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/q parameter/);
    });

    it('returns fallback brief when ANTHROPIC_API_KEY is not set', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const res = await request(app).get('/api/memories/brief?q=React');
      expect(res.status).toBe(200);
      expect(res.body.brief).toBeTruthy();
      expect(res.body.note).toMatch(/ANTHROPIC_API_KEY/);
    });

    it('returns "No memories found" when search returns empty', async () => {
      memorySearchSql.mockResolvedValue([]);
      const res = await request(app).get('/api/memories/brief?q=nonexistent');
      expect(res.status).toBe(200);
      expect(res.body.brief).toBe('No memories found.');
    });
  });

  describe('POST /api/memories', () => {
    it('creates a memory with valid payload', async () => {
      const res = await request(app)
        .post('/api/memories')
        .send({ kind: 'decision', title: 'Test', content: 'Test content' });
      expect(res.status).toBe(201);
      expect(res.body.id).toBe('mem-new');
      expect(memoryInsert).toHaveBeenCalledWith(expect.objectContaining({
        namespace: 'dev-panel',
        kind: 'decision',
        title: 'Test',
        content: 'Test content',
        agent: 'dashboard',
      }));
    });

    it('returns 400 when kind is missing', async () => {
      const res = await request(app)
        .post('/api/memories')
        .send({ title: 'Test', content: 'Content' });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid kind', async () => {
      const res = await request(app)
        .post('/api/memories')
        .send({ kind: 'invalid', title: 'Test', content: 'Content' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/kind must be/);
    });

    it('passes tags and work_item_id through', async () => {
      await request(app)
        .post('/api/memories')
        .send({ kind: 'decision', title: 'T', content: 'C', tags: ['foo'], work_item_id: 'wi-123' });
      expect(memoryInsert).toHaveBeenCalledWith(expect.objectContaining({
        tags: ['foo'],
        work_item_id: 'wi-123',
      }));
    });
  });
});
