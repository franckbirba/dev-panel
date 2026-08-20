// GET /readiness/:project_id — mounted on the worker's local HTTP API
// (src/worker/api.js). Tested here against a standalone express app that
// wires the same handler factory, because importing src/worker/api.js
// directly pulls in src/worker/index.js's full BullMQ/Redis boot (no test
// coverage exists for api.js today for that reason — see other routes in
// that file). registerReadinessRoute is the seam: api.js calls it with its
// own `app`, this test calls it with a throwaway one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let workdir;

beforeEach(async () => {
  workdir = await fs.mkdtemp(join(tmpdir(), 'readiness-route-'));
  vi.resetModules();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(workdir, { recursive: true, force: true });
});

async function buildApp() {
  const { registerReadinessRoute } = await import('../../src/worker/readiness-route.js');
  const app = express();
  registerReadinessRoute(app);
  return app;
}

describe('GET /readiness/:project_id', () => {
  it('400s when local_path query param is missing', async () => {
    const app = await buildApp();
    const r = await request(app).get('/readiness/p1');
    expect(r.status).toBe(400);
  });

  it('runs A1-A3 against the given local_path and returns { checks }', async () => {
    vi.doMock('child_process', () => ({
      execSync: vi.fn((cmd) => {
        if (cmd.includes('remote get-url')) return 'git@github.com:EpitechAfrik/Zeno.git\n';
        if (cmd.includes('log -1')) return new Date().toISOString();
        return '';
      })
    }));
    const repo = join(workdir, 'zeno');
    await fs.mkdir(join(repo, '.git'), { recursive: true });

    const app = await buildApp();
    const r = await request(app).get(`/readiness/p1?local_path=${encodeURIComponent(repo)}`);
    expect(r.status).toBe(200);
    expect(r.body.checks.map(c => c.id)).toEqual(['A1', 'A2', 'A3']);
    expect(r.body.checks.every(c => c.status === 'pass')).toBe(true);
  });

  it('reports A1 fail for a project_id whose local_path has no clone', async () => {
    const app = await buildApp();
    const r = await request(app).get(`/readiness/p1?local_path=${encodeURIComponent(join(workdir, 'ghost'))}`);
    expect(r.status).toBe(200);
    expect(r.body.checks.find(c => c.id === 'A1').status).toBe('fail');
  });
});
