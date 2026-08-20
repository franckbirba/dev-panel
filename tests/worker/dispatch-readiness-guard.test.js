// ADR-003 §2 / engine-contract §9-10: enqueueWorkflowStart consults
// readiness (10-min in-memory cache) and refuses to dispatch into a project
// whose readiness is `fail` — same explicit-refusal pattern as
// project_not_linked / project_unresolved already in dispatch.js. This is
// the "precondition stops being a memory note, becomes a guard" requirement.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('enqueueWorkflowStart — readiness guard', () => {
  let enqueueWorkflowStart, __setEnqueueForTests, __resetReadinessCacheForTests;
  let initMasterDatabase, createProject;

  beforeAll(async () => {
    await startPg();
    ({ enqueueWorkflowStart, __setEnqueueForTests, __resetReadinessCacheForTests } =
      await import('../../src/worker/dispatch.js'));
    ({ initMasterDatabase, createProject } = await import('../../src/server/db.js'));
    const tmp = mkdtempSync(join(tmpdir(), 'dispatch-readiness-'));
    initMasterDatabase(tmp);
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => {
    truncateOrchestration();
    __resetReadinessCacheForTests();
  });

  afterEach(() => {
    delete process.env.API_BASE;
    delete process.env.ADMIN_API_KEY;
    globalThis.fetch = undefined;
  });

  function mockFetchFor({ planeId, projectId, localPath, readinessBody, readinessStatus = 200 }) {
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/by-plane-id/')) {
        return new Response(JSON.stringify({
          id: projectId, name: 'guarded-project',
          plane_project_id: planeId, local_path: localPath
        }), { status: 200 });
      }
      if (u.includes('/readiness')) {
        return new Response(JSON.stringify(readinessBody), { status: readinessStatus });
      }
      return new Response('', { status: 200 }); // events/publish best-effort
    });
  }

  it('refuses to dispatch when readiness reports ready:false', async () => {
    process.env.API_BASE = 'https://api.test';
    process.env.ADMIN_API_KEY = 'admin-tok';
    const enqueue = vi.fn().mockResolvedValue({ id: 'should-not-fire' });
    __setEnqueueForTests(enqueue);
    mockFetchFor({
      planeId: 'plane-guard-fail',
      projectId: 'proj-guard-fail',
      localPath: '/home/deploy/projects/guarded',
      readinessBody: { ready: false, checks: [{ id: 'A3', status: 'fail', detail: 'token in remote URL' }] }
    });

    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-guard-1', project_id: 'plane-guard-fail' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('readiness_fail');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('allows dispatch when readiness reports ready:true', async () => {
    process.env.API_BASE = 'https://api.test';
    process.env.ADMIN_API_KEY = 'admin-tok';
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-guard-ok' });
    __setEnqueueForTests(enqueue);
    mockFetchFor({
      planeId: 'plane-guard-ok',
      projectId: 'proj-guard-ok',
      localPath: '/home/deploy/projects/guarded-ok',
      readinessBody: { ready: true, checks: [{ id: 'A1', status: 'pass', detail: 'ok' }] }
    });

    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-guard-2', project_id: 'plane-guard-ok' }
    });
    expect(out.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('caches the readiness result for 10 minutes — a second dispatch does not re-fetch readiness', async () => {
    process.env.API_BASE = 'https://api.test';
    process.env.ADMIN_API_KEY = 'admin-tok';
    __setEnqueueForTests(vi.fn().mockResolvedValue({ id: 'j-cache-1' }));
    mockFetchFor({
      planeId: 'plane-guard-cache',
      projectId: 'proj-guard-cache',
      localPath: '/home/deploy/projects/guarded-cache',
      readinessBody: { ready: true, checks: [] }
    });

    await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-guard-cache-1', project_id: 'plane-guard-cache' }
    });
    const readinessCallsAfterFirst = globalThis.fetch.mock.calls.filter(c => String(c[0]).includes('/readiness')).length;
    expect(readinessCallsAfterFirst).toBe(1);

    __setEnqueueForTests(vi.fn().mockResolvedValue({ id: 'j-cache-2' }));
    await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-guard-cache-2', project_id: 'plane-guard-cache' }
    });
    const readinessCallsAfterSecond = globalThis.fetch.mock.calls.filter(c => String(c[0]).includes('/readiness')).length;
    expect(readinessCallsAfterSecond).toBe(1); // still 1 — cache hit, no new fetch
  });

  it('treats an unreachable readiness endpoint as non-blocking (fails open, not closed) since the endpoint itself already degrades honestly', async () => {
    process.env.API_BASE = 'https://api.test';
    process.env.ADMIN_API_KEY = 'admin-tok';
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-open' });
    __setEnqueueForTests(enqueue);
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/by-plane-id/')) {
        return new Response(JSON.stringify({
          id: 'proj-guard-unreachable', name: 'x',
          plane_project_id: 'plane-guard-unreachable',
          local_path: '/home/deploy/projects/x'
        }), { status: 200 });
      }
      if (u.includes('/readiness')) throw new Error('ECONNREFUSED');
      return new Response('', { status: 200 });
    });

    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-guard-3', project_id: 'plane-guard-unreachable' }
    });
    expect(out.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  // Le trou trouvé en review (2026-08-20) : le premier jet renvoyait
  // ready:true sur erreur SANS regarder le cache, donc une panne de l'API
  // effaçait un `fail` déjà connu — le faux vert exact que l'ADR-003
  // interdit, au pire moment (dispatch actif vers un repo dont le remote
  // porte un token en clair). Le cache expire pour rafraîchir un `pass`,
  // jamais pour oublier un `fail`.
  it('garde un fail connu quand le endpoint devient injoignable (pas de faux vert sur panne)', async () => {
    process.env.API_BASE = 'https://api.test';
    process.env.ADMIN_API_KEY = 'admin-tok';

    // 1er dispatch : readiness répond fail → refus, verdict mis en cache.
    const enqueue1 = vi.fn().mockResolvedValue({ id: 'should-not-fire' });
    __setEnqueueForTests(enqueue1);
    mockFetchFor({
      planeId: 'plane-guard-stale',
      projectId: 'proj-guard-stale',
      localPath: '/home/deploy/projects/leaky',
      readinessBody: { ready: false, checks: [{ id: 'A3', status: 'fail', detail: 'token in remote URL' }] }
    });
    const first = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-stale-1', project_id: 'plane-guard-stale' }
    });
    expect(first.ok).toBe(false);
    expect(enqueue1).not.toHaveBeenCalled();

    // Le cache expire, puis l'API tombe : le verdict fail doit survivre.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
    const enqueue2 = vi.fn().mockResolvedValue({ id: 'should-not-fire-either' });
    __setEnqueueForTests(enqueue2);
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/by-plane-id/')) {
        return new Response(JSON.stringify({
          id: 'proj-guard-stale', name: 'guarded-project',
          plane_project_id: 'plane-guard-stale', local_path: '/home/deploy/projects/leaky'
        }), { status: 200 });
      }
      if (u.includes('/readiness')) throw new Error('ECONNREFUSED');
      return new Response('', { status: 200 });
    });

    const second = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-stale-2', project_id: 'plane-guard-stale' }
    });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('readiness_fail');
    expect(enqueue2).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fail open quand on n\'a JAMAIS eu de verdict et que le endpoint est injoignable', async () => {
    process.env.API_BASE = 'https://api.test';
    process.env.ADMIN_API_KEY = 'admin-tok';
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-never-known' });
    __setEnqueueForTests(enqueue);
    globalThis.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/by-plane-id/')) {
        return new Response(JSON.stringify({
          id: 'proj-never-known', name: 'x',
          plane_project_id: 'plane-never-known', local_path: '/tmp/x'
        }), { status: 200 });
      }
      if (u.includes('/readiness')) throw new Error('ECONNREFUSED');
      return new Response('', { status: 200 });
    });
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-never-known', project_id: 'plane-never-known' }
    });
    expect(out.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not call readiness at all when API_BASE/ADMIN_API_KEY are unset (local dev / unit tests unaffected)', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-no-guard' });
    __setEnqueueForTests(enqueue);
    globalThis.fetch = vi.fn();
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-guard-4' } // no project_id at all → legacy path
    });
    expect(out.ok).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
