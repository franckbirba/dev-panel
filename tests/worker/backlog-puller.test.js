// tests/worker/backlog-puller.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueWorkflowStartMock: vi.fn()
}));

vi.mock('../../src/worker/dispatch.js', () => ({
  enqueueWorkflowStart: mocks.enqueueWorkflowStartMock
}));

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = { ...process.env };

// Routeur fetch : répond états / labels / issues selon le projet dans l'URL.
// `issuesByProject` : { 'proj-a': [issue, ...], 'proj-b': [...] }
function mockPlane(issuesByProject) {
  global.fetch = vi.fn(async (url) => {
    const u = String(url);
    const projectId = Object.keys(issuesByProject).find(p => u.includes(`/projects/${p}/`));
    if (u.includes('/states/')) {
      return { ok: true, json: async () => ({ results: [
        { id: `todo-${projectId}`, group: 'unstarted' },
        { id: `done-${projectId}`, group: 'completed' }
      ] }) };
    }
    if (u.includes('/issues/')) {
      return { ok: true, json: async () => ({
        results: issuesByProject[projectId] || [], next_page_results: false
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function issue(projectId, n) {
  return {
    id: `${projectId}-issue-${n}`, project: projectId,
    state: `todo-${projectId}`, sequence_id: n,
    name: `Item ${n}`, description_html: '<p>desc</p>',
    labels: [], module: null, cycle: null, priority: 'medium'
  };
}

async function loadPuller(env = {}) {
  vi.resetModules();
  Object.assign(process.env, {
    BACKLOG_PULL_ENABLED: 'true',
    PLANE_BASE_URL: 'https://plane.test',
    PLANE_API_KEY: 'k',
    PLANE_WORKSPACE_SLUG: 'devpanl',
    BACKLOG_PULL_MAX_PER_TICK: '3',
    BACKLOG_PULL_STATE_GROUPS: 'unstarted',
    BACKLOG_PULL_LABEL: '',
    ...env
  });
  return import('../../src/worker/backlog-puller.js');
}

describe('backlog-puller multi-projet', () => {
  beforeEach(() => {
    mocks.enqueueWorkflowStartMock.mockReset();
    mocks.enqueueWorkflowStartMock.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env = { ...ORIGINAL_ENV };
  });

  it('dispatche les issues de chaque projet listé dans BACKLOG_PULL_PROJECT_IDS', async () => {
    mockPlane({ 'proj-a': [issue('proj-a', 1)], 'proj-b': [issue('proj-b', 2)] });
    const { tick } = await loadPuller({ BACKLOG_PULL_PROJECT_IDS: 'proj-a,proj-b' });
    await tick();
    const calls = mocks.enqueueWorkflowStartMock.mock.calls.map(c => c[0].plane.project_id);
    expect(calls).toContain('proj-a');
    expect(calls).toContain('proj-b');
  });

  it('respecte le budget global MAX_PER_TICK tous projets confondus', async () => {
    mockPlane({
      'proj-a': [issue('proj-a', 1), issue('proj-a', 2)],
      'proj-b': [issue('proj-b', 3), issue('proj-b', 4), issue('proj-b', 5)]
    });
    const { tick } = await loadPuller({ BACKLOG_PULL_PROJECT_IDS: 'proj-a,proj-b' });
    await tick();
    expect(mocks.enqueueWorkflowStartMock).toHaveBeenCalledTimes(3); // 2 de A + 1 de B
  });

  it("continue sur le projet suivant si un projet échoue", async () => {
    mockPlane({ 'proj-b': [issue('proj-b', 1)] }); // proj-a → 404 sur /states/
    const { tick } = await loadPuller({ BACKLOG_PULL_PROJECT_IDS: 'proj-a,proj-b' });
    await tick();
    const calls = mocks.enqueueWorkflowStartMock.mock.calls.map(c => c[0].plane.project_id);
    expect(calls).toEqual(['proj-b']);
  });

  it('retombe sur PLANE_PROJECT_ID quand BACKLOG_PULL_PROJECT_IDS est absent', async () => {
    mockPlane({ 'proj-legacy': [issue('proj-legacy', 1)] });
    const { tick } = await loadPuller({
      BACKLOG_PULL_PROJECT_IDS: '', PLANE_PROJECT_ID: 'proj-legacy'
    });
    await tick();
    expect(mocks.enqueueWorkflowStartMock.mock.calls[0][0].plane.project_id).toBe('proj-legacy');
  });
});
