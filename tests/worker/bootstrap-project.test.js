import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('child_process', () => ({
  spawn: vi.fn()
}));
vi.mock('../../src/server/alerts.js', () => ({
  notifyJob: vi.fn()
}));

describe('bootstrap_project handler', () => {
  let spawnMock, notifyMock;
  beforeEach(async () => {
    const cp = await import('child_process');
    spawnMock = cp.spawn;
    const al = await import('../../src/server/alerts.js');
    notifyMock = al.notifyJob;
    spawnMock.mockReset();
    notifyMock.mockReset();
  });

  function fakeProc(exitCode, stderr = '') {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    setTimeout(() => {
      if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('exit', exitCode);
    }, 5);
    return proc;
  }

  it('runs git clone and notifies done on exit 0', { timeout: 10000 }, async () => {
    spawnMock.mockReturnValue(fakeProc(0));
    const { handleBootstrapProject } = await import('../../src/worker/handlers/bootstrap-project.js');
    await handleBootstrapProject({
      data: { project_id: 'proj_1', github_url: 'https://github.com/me/x', target_path: '/tmp/x' },
      id: 'job_1'
    });
    expect(spawnMock).toHaveBeenCalledWith('git', expect.arrayContaining(['clone', 'https://github.com/me/x', '/tmp/x']), expect.any(Object));
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'bootstrap', status: 'done', work_item_id: 'proj_1'
    }));
  });

  it('notifies failed on non-zero exit and rethrows for BullMQ retry', async () => {
    spawnMock.mockReturnValue(fakeProc(128, 'fatal: Repository not found'));
    const { handleBootstrapProject } = await import('../../src/worker/handlers/bootstrap-project.js');
    await expect(handleBootstrapProject({
      data: { project_id: 'proj_2', github_url: 'https://github.com/me/missing', target_path: '/tmp/missing' },
      id: 'job_2'
    })).rejects.toThrow(/Repository not found/);
    expect(notifyMock).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'bootstrap', status: 'failed', work_item_id: 'proj_2'
    }));
  });
});
