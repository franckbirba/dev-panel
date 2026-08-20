// engine-contract §10: "Le backlog-puller est OFF par défaut
// (BACKLOG_PULL_MAX_PER_TICK=0)." Two incidents (11/08 and 19/08) had the
// puller dispatch unrequested jobs on worker startup. Default changed from
// 3 to 0: at 0 the puller makes zero Plane calls and logs a single clear
// line at startup (not per-tick) rather than silently doing nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueueWorkflowStartMock: vi.fn()
}));

vi.mock('../../src/worker/dispatch.js', () => ({
  enqueueWorkflowStart: mocks.enqueueWorkflowStartMock
}));

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = { ...process.env };

async function loadPuller(env = {}) {
  vi.resetModules();
  Object.assign(process.env, {
    BACKLOG_PULL_ENABLED: 'true',
    PLANE_BASE_URL: 'https://plane.test',
    PLANE_API_KEY: 'k',
    PLANE_WORKSPACE_SLUG: 'devpanl',
    BACKLOG_PULL_PROJECT_IDS: 'proj-a',
    // deliberately NOT setting BACKLOG_PULL_MAX_PER_TICK — exercising the default
    ...env
  });
  return import('../../src/worker/backlog-puller.js');
}

describe('backlog-puller — OFF by default (BACKLOG_PULL_MAX_PER_TICK=0)', () => {
  beforeEach(() => {
    mocks.enqueueWorkflowStartMock.mockReset();
    mocks.enqueueWorkflowStartMock.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it('tick() makes zero Plane calls and dispatches nothing when MAX_PER_TICK is unset', async () => {
    global.fetch = vi.fn(); // must never be called
    const { tick } = await loadPuller();
    await tick();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkflowStartMock).not.toHaveBeenCalled();
  });

  it('tick() makes zero Plane calls when BACKLOG_PULL_MAX_PER_TICK is explicitly "0"', async () => {
    global.fetch = vi.fn();
    const { tick } = await loadPuller({ BACKLOG_PULL_MAX_PER_TICK: '0' });
    await tick();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkflowStartMock).not.toHaveBeenCalled();
  });

  it('startBacklogPuller logs the disabled-by-budget line exactly once at startup, not per tick', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    global.fetch = vi.fn();
    const { startBacklogPuller, tick, stopBacklogPuller } = await loadPuller();
    startBacklogPuller();
    const messages = () => logSpy.mock.calls.map(c => c.join(' '));
    expect(messages().filter(m => /BACKLOG_PULL_MAX_PER_TICK=0/.test(m))).toHaveLength(1);

    // Ticking repeatedly must not repeat the line — "une seule fois au
    // démarrage, pas à chaque tick" per the spec.
    await tick();
    await tick();
    await tick();
    expect(messages().filter(m => /BACKLOG_PULL_MAX_PER_TICK=0/.test(m))).toHaveLength(1);

    stopBacklogPuller();
    logSpy.mockRestore();
  });

  it('a positive BACKLOG_PULL_MAX_PER_TICK still dispatches (explicit opt-in works)', async () => {
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/states/')) {
        return { ok: true, json: async () => ({ results: [{ id: 'todo-proj-a', group: 'unstarted' }] }) };
      }
      if (u.includes('/issues/')) {
        return { ok: true, json: async () => ({
          results: [{
            id: 'proj-a-issue-1', project: 'proj-a', state: 'todo-proj-a',
            sequence_id: 1, name: 'Item 1', description_html: '<p>x</p>',
            labels: [], module: null, cycle: null, priority: 'medium'
          }],
          next_page_results: false
        }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { tick } = await loadPuller({ BACKLOG_PULL_MAX_PER_TICK: '1' });
    await tick();
    expect(mocks.enqueueWorkflowStartMock).toHaveBeenCalledTimes(1);
  });
});
