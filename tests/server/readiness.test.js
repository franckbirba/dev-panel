// ADR-003 §1/§2 — the readiness contract. computeServicesChecks is pure
// (S1-S3, DB row only, no network). checkReadiness orchestrates S1-S3 +
// calls out to the worker (WORKER_API_URL) for A1-A3, and MUST degrade to
// explicit `warn` (never a false pass) when the worker is unreachable —
// that's the ADR's explicit "never a false green" requirement.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeServicesChecks,
  checkReadiness
} from '../../src/server/readiness.js';

describe('computeServicesChecks (S1-S3, pure)', () => {
  it('fails S1 when the project row itself is missing', () => {
    const checks = computeServicesChecks(null);
    expect(checks.find(c => c.id === 'S1').status).toBe('fail');
  });

  it('passes every services check for a fully-linked project', () => {
    const project = {
      id: 'p1',
      plane_project_id: 'plane-uuid',
      local_path: '/home/deploy/projects/zeno',
      github_owner: 'EpitechAfrik',
      github_repo: 'Zeno',
      default_branch: 'main'
    };
    const checks = computeServicesChecks(project);
    expect(checks.every(c => c.status === 'pass')).toBe(true);
    expect(checks.map(c => c.id)).toEqual(expect.arrayContaining(['S1', 'S2', 'S3']));
  });

  it('fails S2 (plane_project_id) when unset', () => {
    const project = { id: 'p1', local_path: '/x', github_owner: 'o', github_repo: 'r' };
    const checks = computeServicesChecks(project);
    expect(checks.find(c => c.id === 'S2').status).toBe('fail');
  });

  it('fails S3 (local_path) when unset', () => {
    const project = { id: 'p1', plane_project_id: 'pl', github_owner: 'o', github_repo: 'r' };
    const checks = computeServicesChecks(project);
    expect(checks.find(c => c.id === 'S3').status).toBe('fail');
  });

  it('fails S4 (github owner/repo) when either is unset', () => {
    const project = { id: 'p1', plane_project_id: 'pl', local_path: '/x', github_owner: 'o', github_repo: null };
    const checks = computeServicesChecks(project);
    expect(checks.find(c => c.id === 'S4').status).toBe('fail');
  });

  it('warns S5 (default_branch) when unset — not a hard blocker', () => {
    const project = { id: 'p1', plane_project_id: 'pl', local_path: '/x', github_owner: 'o', github_repo: 'r', default_branch: null };
    const checks = computeServicesChecks(project);
    expect(checks.find(c => c.id === 'S5').status).toBe('warn');
  });
});

describe('checkReadiness (S1-S3 + worker-delegated A1-A3)', () => {
  const ORIGINAL_FETCH = global.fetch;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.WORKER_API_URL = 'http://worker.test:3099';
  });

  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env = { ...ORIGINAL_ENV };
  });

  const validProject = {
    id: 'p1',
    plane_project_id: 'plane-uuid',
    local_path: '/home/deploy/projects/zeno',
    github_owner: 'EpitechAfrik',
    github_repo: 'Zeno',
    default_branch: 'main'
  };

  it('ready:false when the project row is missing entirely', async () => {
    const out = await checkReadiness(null);
    expect(out.ready).toBe(false);
    expect(out.checks.find(c => c.id === 'S1').status).toBe('fail');
  });

  it('merges pass agents-host checks from the worker when reachable, passing local_path in the query string', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      checks: [
        { id: 'A1', status: 'pass', detail: 'clone exists' },
        { id: 'A2', status: 'pass', detail: 'fetched 3h ago' },
        { id: 'A3', status: 'pass', detail: 'ssh remote, no token in URL' }
      ]
    }), { status: 200 }));
    const out = await checkReadiness(validProject);
    expect(out.ready).toBe(true);
    expect(out.checks.find(c => c.id === 'A1').status).toBe('pass');
    expect(out.checks.find(c => c.id === 'A3').status).toBe('pass');
    // The worker's own SQLite is empty on the agents host (DEVPA-180) — it
    // cannot resolve project_id → local_path itself, so services passes it.
    const [calledUrl] = global.fetch.mock.calls[0];
    expect(String(calledUrl)).toContain(`/readiness/${validProject.id}`);
    expect(String(calledUrl)).toContain(`local_path=${encodeURIComponent(validProject.local_path)}`);
  });

  it('degrades A1-A3 to warn without calling the worker when local_path is unset', async () => {
    global.fetch = vi.fn();
    const out = await checkReadiness({ ...validProject, local_path: null });
    expect(global.fetch).not.toHaveBeenCalled();
    const agentChecks = out.checks.filter(c => ['A1', 'A2', 'A3'].includes(c.id));
    for (const c of agentChecks) expect(c.status).toBe('warn');
  });

  it('is not ready when the worker reports A3 (token-in-url) as fail', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      checks: [
        { id: 'A1', status: 'pass', detail: 'clone exists' },
        { id: 'A2', status: 'pass', detail: 'fetched 3h ago' },
        { id: 'A3', status: 'fail', detail: 'remote URL contains an embedded token' }
      ]
    }), { status: 200 }));
    const out = await checkReadiness(validProject);
    expect(out.ready).toBe(false);
    expect(out.checks.find(c => c.id === 'A3').status).toBe('fail');
  });

  it('degrades A1-A3 to warn (never a false pass) when WORKER_API_URL is unset', async () => {
    delete process.env.WORKER_API_URL;
    global.fetch = vi.fn(); // must not even be called
    const out = await checkReadiness(validProject);
    expect(global.fetch).not.toHaveBeenCalled();
    const agentChecks = out.checks.filter(c => ['A1', 'A2', 'A3'].includes(c.id));
    expect(agentChecks.length).toBeGreaterThan(0);
    for (const c of agentChecks) {
      expect(c.status).toBe('warn');
      expect(c.detail).toMatch(/agents host non v[ée]rifiable/i);
    }
    // Services-side checks alone are all green, so overall readiness is
    // driven purely by warn (not fail) — still not silently "ready" though
    // the ADR only requires "never a false green" on the A* class itself.
    expect(out.ready).toBe(true);
  });

  it('degrades A1-A3 to warn when the worker is unreachable (fetch throws)', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const out = await checkReadiness(validProject);
    const agentChecks = out.checks.filter(c => ['A1', 'A2', 'A3'].includes(c.id));
    for (const c of agentChecks) {
      expect(c.status).toBe('warn');
      expect(c.detail).toMatch(/agents host non v[ée]rifiable/i);
    }
  });

  it('degrades A1-A3 to warn when the worker responds non-200', async () => {
    global.fetch = vi.fn(async () => new Response('boom', { status: 500 }));
    const out = await checkReadiness(validProject);
    const agentChecks = out.checks.filter(c => ['A1', 'A2', 'A3'].includes(c.id));
    for (const c of agentChecks) {
      expect(c.status).toBe('warn');
    }
  });

  it('ready:false overall when a services check fails even if agent checks pass', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      checks: [
        { id: 'A1', status: 'pass', detail: 'ok' },
        { id: 'A2', status: 'pass', detail: 'ok' },
        { id: 'A3', status: 'pass', detail: 'ok' }
      ]
    }), { status: 200 }));
    const out = await checkReadiness({ id: 'p1', local_path: '/x' }); // no plane_project_id
    expect(out.ready).toBe(false);
  });
});
