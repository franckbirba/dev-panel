// tests/worker/dispatch.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('enqueueWorkflowStart', () => {
  let loadInstance, enqueueWorkflowStart, __setEnqueueForTests;
  let initMasterDatabase, createProject;

  beforeAll(async () => {
    await startPg();
    ({ loadInstance } = await import('../../src/server/workflow-instances.js'));
    ({ enqueueWorkflowStart, __setEnqueueForTests } = await import('../../src/worker/dispatch.js'));
    ({ initMasterDatabase, createProject } = await import('../../src/server/db.js'));
    const tmp = mkdtempSync(join(tmpdir(), 'dispatch-'));
    initMasterDatabase(tmp);
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateOrchestration());

  it('creates instance + enqueues first step of workflow', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-1' });
    __setEnqueueForTests(enqueue);
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-d1', module_id: 'm', cycle_id: 'c' },
      work_item: { title: 'x' }
    });
    expect(out.ok).toBe(true);
    expect(Number(out.instance_id)).toBeGreaterThan(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0].agent).toBe('builder');
    expect(enqueue.mock.calls[0][0].workflow_revision).toBe(1);
    const inst = await loadInstance({ work_item_id: 'wi-d1', workflow_name: 'work-item' });
    expect(inst.status).toBe('running');
    expect(inst.current_step).toBe('builder');
  });

  it('duplicate dispatch on active instance returns { ok:false, error:"already_running" }', async () => {
    __setEnqueueForTests(vi.fn().mockResolvedValue({ id: 'j' }));
    await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-d2' }
    });
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-d2' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('already_running');
  });

  it('rejects unknown workflow', async () => {
    const out = await enqueueWorkflowStart({
      workflow: 'no-such-flow',
      plane: { work_item_id: 'wi-d3' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown workflow/);
  });

  it('resolves project_root from plane.project_id and puts it on context', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-pr' });
    __setEnqueueForTests(enqueue);
    const planeId = 'plane-zeno-uuid';
    createProject({ name: `zeno-${Date.now()}`,
                    plane_project_id: planeId,
                    local_path: '/home/deploy/projects/zeno' });
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-pr1', project_id: planeId },
      work_item: { title: 'cross-repo dispatch' }
    });
    expect(out.ok).toBe(true);
    expect(enqueue.mock.calls[0][0].context.project_root).toBe('/home/deploy/projects/zeno');
  });

  it('caller-supplied context.project_root wins over the lookup', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-pr2' });
    __setEnqueueForTests(enqueue);
    const planeId = 'plane-edms-uuid';
    createProject({ name: `edms-${Date.now()}`,
                    plane_project_id: planeId,
                    local_path: '/home/deploy/projects/edms' });
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-pr2', project_id: planeId },
      work_item: { title: 'override' },
      context: { project_root: '/tmp/override' }
    });
    expect(out.ok).toBe(true);
    expect(enqueue.mock.calls[0][0].context.project_root).toBe('/tmp/override');
  });

  it('refuses to enqueue when plane.project_id is set but no project matches', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-pr3' });
    __setEnqueueForTests(enqueue);
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-pr3', project_id: 'unknown-plane-id' },
      work_item: { title: 'no project' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('project_not_linked');
    expect(out.message).toMatch(/unknown-plane-id/);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still enqueues when plane.project_id is omitted entirely (legacy ad-hoc dispatches)', async () => {
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-pr4' });
    __setEnqueueForTests(enqueue);
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-pr4' },
      work_item: { title: 'no project_id' }
    });
    expect(out.ok).toBe(true);
    expect(enqueue.mock.calls[0][0].context.project_root).toBeUndefined();
  });

  it('refuses UUID work_item_id when project_id cannot be resolved (would otherwise route to PROJECT_ROOT)', async () => {
    // Real-world failure: Shelly calls plane_dispatch_work_item with a UUID,
    // managed-projects fan-out returns nothing (missing env, cache miss),
    // resolveProjectIdFromWorkItemUuid → null. Old behaviour silently fell
    // back to PROJECT_ROOT (= dev-panel) and ZENO/EDMS builders ran in the
    // wrong checkout, exit 0, no PR. Now we refuse loudly.
    const enqueue = vi.fn().mockResolvedValue({ id: 'should-not-fire' });
    __setEnqueueForTests(enqueue);
    const prev = process.env.PLANE_API_KEY;
    delete process.env.PLANE_API_KEY; // force resolveProjectIdFromWorkItemUuid → null
    try {
      const out = await enqueueWorkflowStart({
        workflow: 'work-item',
        plane: { work_item_id: '11111111-2222-3333-4444-555555555555' },
        work_item: { title: 'unrouted UUID' }
      });
      expect(out.ok).toBe(false);
      expect(out.error).toBe('project_unresolved');
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.PLANE_API_KEY = prev;
    }
  });

  it('cancelActiveInstances flips active rows to cancelled and lets a fresh dispatch land', async () => {
    const { cancelActiveInstances } = await import('../../src/server/workflow-instances.js');
    const enqueue = vi.fn().mockResolvedValue({ id: 'j-cancel' });
    __setEnqueueForTests(enqueue);
    // First dispatch creates the instance in 'running'.
    const first = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-cancel' }
    });
    expect(first.ok).toBe(true);
    // Second dispatch (without force) is blocked by the unique partial index.
    const blocked = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-cancel' }
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe('already_running');
    // cancelActiveInstances clears the row.
    const cancelled = await cancelActiveInstances({ work_item_id: 'wi-cancel' });
    expect(cancelled.cancelled_count).toBe(1);
    expect(cancelled.cancelled_ids).toHaveLength(1);
    // Now a fresh dispatch lands.
    const retry = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-cancel' }
    });
    expect(retry.ok).toBe(true);
    expect(Number(retry.instance_id)).toBeGreaterThan(Number(first.instance_id));
  });

  it('cancelActiveInstances is a no-op when no rows are active', async () => {
    const { cancelActiveInstances } = await import('../../src/server/workflow-instances.js');
    const r = await cancelActiveInstances({ work_item_id: 'wi-never-existed' });
    expect(r.cancelled_count).toBe(0);
    expect(r.cancelled_ids).toEqual([]);
  });

  it('cancelActiveInstances cancels both work-item and replan rows for the same work_item_id', async () => {
    const { cancelActiveInstances } = await import('../../src/server/workflow-instances.js');
    const { createInstance } = await import('../../src/server/workflow-instances.js');
    const wi = 'wi-cancel-multi';
    await createInstance({ work_item_id: wi, workflow_name: 'work-item', current_step: 'builder' });
    await createInstance({ work_item_id: wi, workflow_name: 'replan', current_step: 'pm' });
    const r = await cancelActiveInstances({ work_item_id: wi });
    expect(r.cancelled_count).toBe(2);
  });

  it('rolls back the instance to failed when enqueue throws', async () => {
    __setEnqueueForTests(vi.fn().mockRejectedValue(new Error('redis down')));
    const out = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-rollback' }
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/enqueue_failed/);
    // The row should now be 'failed', so a follow-up dispatch can land fresh.
    __setEnqueueForTests(vi.fn().mockResolvedValue({ id: 'retry-1' }));
    const retry = await enqueueWorkflowStart({
      workflow: 'work-item',
      plane: { work_item_id: 'wi-rollback' }
    });
    expect(retry.ok).toBe(true);
    expect(Number(retry.instance_id)).toBeGreaterThan(0);
  });

  // DEVPA-180: dispatcher prefers HTTP lookup against /api/admin/projects
  // when API_BASE + ADMIN_API_KEY are set — covers the agents-host case
  // where the local SQLite is empty.
  describe('HTTP lookup of plane.project_id (DEVPA-180)', () => {
    let originalFetch;
    let originalApiBase;
    let originalAdminKey;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      originalApiBase = process.env.API_BASE;
      originalAdminKey = process.env.ADMIN_API_KEY;
      process.env.API_BASE = 'https://api.test';
      process.env.ADMIN_API_KEY = 'admin-tok';
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      if (originalApiBase === undefined) delete process.env.API_BASE; else process.env.API_BASE = originalApiBase;
      if (originalAdminKey === undefined) delete process.env.ADMIN_API_KEY; else process.env.ADMIN_API_KEY = originalAdminKey;
    });

    it('resolves project_root via HTTP 200 and ignores any local SQLite row', async () => {
      // Sanity: no local row for this plane_id, so a fallback hit would fail.
      const planeId = 'plane-http-200-uuid';
      const enqueue = vi.fn().mockResolvedValue({ id: 'j-http-1' });
      __setEnqueueForTests(enqueue);

      // The dispatcher makes TWO fetches per dispatch: the by-plane-id lookup
      // and a fire-and-forget publishEvent. Capture every call so the assert
      // doesn't depend on which one happens last.
      const fetchCalls = [];
      globalThis.fetch = vi.fn(async (url, init = {}) => {
        fetchCalls.push({ url: String(url), headers: init.headers || {} });
        if (String(url).includes('/api/admin/projects/by-plane-id/')) {
          return new Response(JSON.stringify({
            id: 'p1', name: 'Zeno',
            plane_project_id: planeId,
            local_path: '/home/deploy/projects/Zeno',
            github_owner: 'EpitechAfrik',
            github_repo: 'Zeno',
            default_branch: 'main'
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        // events/publish — best-effort, return a no-op 200.
        return new Response('', { status: 200 });
      });

      const out = await enqueueWorkflowStart({
        workflow: 'work-item',
        plane: { work_item_id: 'wi-http-1', project_id: planeId }
      });
      expect(out.ok).toBe(true);
      const ctx = enqueue.mock.calls[0][0].context;
      expect(ctx.project_root).toBe('/home/deploy/projects/Zeno');
      // Cross-repo PR target — without this, publishWorkItem creates the PR
      // on franckbirba/dev-panel instead of EpitechAfrik/Zeno (no PR ever showed up).
      expect(ctx.github_repo).toBe('EpitechAfrik/Zeno');
      expect(ctx.default_branch).toBe('main');
      const lookup = fetchCalls.find(c => c.url.includes('/by-plane-id/'));
      expect(lookup).toBeDefined();
      expect(lookup.url).toContain(`/api/admin/projects/by-plane-id/${planeId}`);
      expect(lookup.headers['X-Admin-Key']).toBe('admin-tok');
    });

    it('omits context.github_repo when the projects row has no github_owner/github_repo (legacy local-only project)', async () => {
      const planeId = 'plane-no-gh-uuid';
      const enqueue = vi.fn().mockResolvedValue({ id: 'j-no-gh' });
      __setEnqueueForTests(enqueue);
      globalThis.fetch = vi.fn(async (url) => {
        if (String(url).includes('/api/admin/projects/by-plane-id/')) {
          return new Response(JSON.stringify({
            id: 'p2', name: 'local-only',
            plane_project_id: planeId,
            local_path: '/home/deploy/projects/local-only'
            // no github_owner / github_repo
          }), { status: 200 });
        }
        return new Response('', { status: 200 });
      });
      const out = await enqueueWorkflowStart({
        workflow: 'work-item',
        plane: { work_item_id: 'wi-no-gh', project_id: planeId }
      });
      expect(out.ok).toBe(true);
      const ctx = enqueue.mock.calls[0][0].context;
      expect(ctx.project_root).toBe('/home/deploy/projects/local-only');
      // No GH info → publishWorkItem falls back to its hardcoded default.
      expect(ctx.github_repo).toBeUndefined();
    });

    it('returns project_not_linked when API responds 404', async () => {
      const enqueue = vi.fn().mockResolvedValue({ id: 'j-http-404' });
      __setEnqueueForTests(enqueue);
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'project_not_linked' }), { status: 404 })
      );
      const out = await enqueueWorkflowStart({
        workflow: 'work-item',
        plane: { work_item_id: 'wi-http-404', project_id: 'plane-missing' }
      });
      expect(out.ok).toBe(false);
      expect(out.error).toBe('project_not_linked');
      expect(out.message).toMatch(/plane-missing/);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('returns project_lookup_failed when fetch throws (network down)', async () => {
      const enqueue = vi.fn().mockResolvedValue({ id: 'j-http-err' });
      __setEnqueueForTests(enqueue);
      globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
      const out = await enqueueWorkflowStart({
        workflow: 'work-item',
        plane: { work_item_id: 'wi-http-err', project_id: 'plane-x' }
      });
      expect(out.ok).toBe(false);
      expect(out.error).toMatch(/project_lookup_failed/);
      expect(out.error).toMatch(/ECONNREFUSED/);
      expect(enqueue).not.toHaveBeenCalled();
    });
  });
});
