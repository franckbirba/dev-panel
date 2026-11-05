import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KimiCodeCliDriver } from '../../src/worker/kimi-code-cli-driver.js';

function fakeProcess(pid = 4242) {
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

describe('KimiCodeCliDriver', () => {
  let worktree;
  let proc;
  let spawnImpl;
  let calls;
  let events;
  let driver;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'kimi-driver-'));
    proc = fakeProcess();
    calls = [];
    events = [];
    spawnImpl = (command, args, options) => {
      calls.push({ command, args, options });
      return proc;
    };
    driver = new KimiCodeCliDriver({ spawnImpl, onEvent: event => events.push(event) });
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it('lance Kimi en stream-json et normalise les événements avec un artefact réel', () => {
    const handle = driver.start(runSpec(worktree), 'Réponds uniquement par OK');
    const call = calls[0];

    expect(call.command).toBe('kimi');
    expect(call.args).toEqual(['-p', 'Réponds uniquement par OK', '--output-format', 'stream-json']);
    expect(call.options.cwd).toBe(worktree);
    expect(handle.status).toBe('running');

    proc.stdout.emit('data', Buffer.from('{"role":"meta","type":"system.version","version":"2.3.3"}\n'));
    proc.stdout.emit('data', Buffer.from('{"role":"assistant","content":"OK"}\n'));
    proc.stdout.emit('data', Buffer.from('{"role":"meta","type":"session.resume_hint","session_id":"session_c9c1c5d3-448c-4c50-96d2-491b6e52f509"}\n'));
    proc.emit('close', 0);

    expect(handle.native_session_id).toBe('session_c9c1c5d3-448c-4c50-96d2-491b6e52f509');
    expect(handle.status).toBe('completed');
    expect(events.map(event => event.type)).toEqual([
      'started', 'stdout', 'artifact_created', 'completed'
    ]);
    expect(events[0].payload).toEqual({
      driver: 'kimi-code-cli',
      process_id: 4242,
      native_session_id: null
    });
    expect(events[1].payload).toEqual({ content: 'OK', truncated: false });

    const artifact = handle.artifacts[0];
    expect(artifact.kind).toBe('session-export');
    expect(artifact.mime_type).toBe('application/x-ndjson');
    expect(artifact.size_bytes).toBeGreaterThan(0);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(artifact.path)).toBe(true);
    expect(events[3].payload.artifacts).toHaveLength(1);
    expect(events[3].payload.artifacts[0].sha256).toBe(artifact.sha256);
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('n’écrit pas les secrets dans le journal ou les événements', () => {
    driver.start(runSpec(worktree), 'Test');
    proc.stdout.emit('data', Buffer.from('{"role":"assistant","content":"Bearer abcdef1234567890"}\n'));
    proc.emit('close', 0);

    const artifact = events.find(event => event.type === 'artifact_created').payload;
    const log = readFileSync(artifact.path, 'utf8');
    expect(log).not.toContain('abcdef1234567890');
    expect(log).toContain('[REDACTED]');
    expect(events[1].payload.content).toBe('[REDACTED]');
  });

  it('reprend une session native et émet resumed', () => {
    const handle = driver.resume(
      runSpec(worktree),
      'Continue',
      {
        nativeSessionId: 'session_c9c1c5d3-448c-4c50-96d2-491b6e52f509',
        decision: {
          decision_id: '2d4f2a15-2f58-4f65-9f3e-2de61a4f5a20',
          selected_option: 'continue',
          decided_by: 'franck'
        }
      }
    );

    expect(calls[0].args).toEqual([
      '--session', 'session_c9c1c5d3-448c-4c50-96d2-491b6e52f509',
      '-p', 'Continue', '--output-format', 'stream-json'
    ]);
    expect(events[0].type).toBe('resumed');
    expect(events[0].payload.selected_option).toBe('continue');
    expect(handle.native_session_id).toBe('session_c9c1c5d3-448c-4c50-96d2-491b6e52f509');
  });

  it('normalise stderr et un exit non nul', () => {
    driver.start(runSpec(worktree), 'Test');
    proc.stderr.emit('data', Buffer.from('provider unavailable'));
    proc.emit('close', 1);

    const types = events.map(event => event.type);
    expect(types).toContain('stderr');
    expect(types.at(-1)).toBe('failed');
    expect(events.at(-1).payload).toEqual({
      error_code: 'process_exit_nonzero',
      message: 'Kimi Code CLI exited with code 1',
      retryable: false
    });
  });

  it('annule le processus et émet cancelled uniquement après son arrêt', async () => {
    const handle = driver.start(runSpec(worktree), 'Test');
    const pending = driver.cancel(handle, { reason: 'operator_stop', cancelled_by: 'franck' });

    expect(events.map(event => event.type)).not.toContain('cancelled');
    await pending;

    expect(handle.status).toBe('cancelled');
    expect(events.at(-1).type).toBe('cancelled');
    expect(events.at(-1).payload).toEqual({
      reason: 'operator_stop',
      cancelled_by: 'franck'
    });
  });
});
