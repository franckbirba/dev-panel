import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OpenCodeCliDriver } from '../../src/worker/opencode-cli-driver.js';

function fakeProcess(pid = 4646) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    queueMicrotask(() => proc.emit('close', 143));
    return true;
  };
  return proc;
}

function runSpec(worktree) {
  return {
    run_id: '2d4f2a15-2f58-4f65-9f3e-2de61a4f5a20',
    worktree: { path: worktree },
  };
}

describe('OpenCodeCliDriver', () => {
  let worktree;
  let proc;
  let calls;
  let events;
  let driver;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'opencode-driver-'));
    proc = fakeProcess();
    calls = [];
    events = [];
    driver = new OpenCodeCliDriver({
      spawnImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return proc;
      },
      onEvent: event => events.push(event)
    });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it('lance OpenCode et normalise session, texte et artefact', () => {
    const handle = driver.start(runSpec(worktree), 'Réponds OK');
    expect(calls[0].command).toBe('opencode');
    expect(calls[0].args).toEqual(['run', 'Réponds OK', '--format', 'json']);

    proc.stdout.emit('data', Buffer.from('{"type":"step_start","sessionID":"ses_test","part":{"type":"step-start"}}\n'));
    proc.stdout.emit('data', Buffer.from('{"type":"text","sessionID":"ses_test","part":{"type":"text","text":"OK"}}\n'));
    proc.emit('close', 0);

    expect(handle.native_session_id).toBe('ses_test');
    expect(handle.status).toBe('completed');
    expect(events.map(event => event.type)).toEqual([
      'started', 'stdout', 'artifact_created', 'completed'
    ]);
    expect(events[1].payload).toEqual({ content: 'OK', truncated: false });
    expect(existsSync(handle.artifacts[0].path)).toBe(true);
  });

  it('normalise un exit non nul', () => {
    driver.start(runSpec(worktree), 'Test');
    proc.emit('close', 1);

    expect(events.at(-1).type).toBe('failed');
    expect(events.at(-1).payload.error_code).toBe('process_exit_nonzero');
  });

  it('annule le processus et émet cancelled après son arrêt', async () => {
    const handle = driver.start(runSpec(worktree), 'Test');
    const pending = driver.cancel(handle, { reason: 'operator_stop', cancelled_by: 'franck' });

    expect(events.map(event => event.type)).not.toContain('cancelled');
    await pending;

    expect(handle.status).toBe('cancelled');
    expect(events.at(-1).payload).toEqual({
      reason: 'operator_stop',
      cancelled_by: 'franck'
    });
  });
});
