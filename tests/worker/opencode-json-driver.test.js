import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { OpenCodeJsonDriver } from '../../src/worker/opencode-json-driver.js';

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

describe('OpenCodeJsonDriver', () => {
  let worktree;
  let proc;
  let calls;
  let events;
  let driver;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'opencode-json-driver-'));
    proc = fakeProcess();
    calls = [];
    events = [];
    driver = new OpenCodeJsonDriver({
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

  it('lance OpenCode avec --format json et normalise session, texte et artefact', () => {
    const handle = driver.start(runSpec(worktree), 'Réponds OK');
    expect(calls[0].command).toBe('opencode');
    expect(calls[0].args).toEqual(['run', '--format', 'json', 'Réponds OK']);

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

  it('reprend une session native avec --session', () => {
    driver.resume(runSpec(worktree), 'Continue', {
      nativeSessionId: 'ses_test',
      decision: { decision_id: 'decision-1' }
    });

    expect(calls[0].args).toEqual([
      'run', '--format', 'json', '--session', 'ses_test', 'Continue'
    ]);
    expect(events[0].type).toBe('resumed');
  });

  it('normalise et déduplique les snapshots tool_use OpenCode 2.1.4', () => {
    driver.start(runSpec(worktree), 'Test');
    const completed = '{"type":"tool_use","sessionID":"ses_test","part":{"id":"call-1","partID":"part-1","type":"tool","tool":"shell","state":{"status":"completed","input":{"command":"pwd"},"output":"/tmp/demo\\n"}}}\n';
    proc.stdout.emit('data', Buffer.from(completed));
    proc.stdout.emit('data', Buffer.from(completed));
    proc.stdout.emit('data', Buffer.from('{"type":"tool_use","sessionID":"ses_test","part":{"id":"call-2","partID":"part-2","type":"tool","tool":"shell","state":{"status":"error","input":{"command":"false"},"error":"exit 1"}}}\n'));

    const toolEvents = events.filter(event => event.type.startsWith('tool_'));
    expect(toolEvents.map(event => event.type)).toEqual([
      'tool_started', 'tool_finished', 'tool_started', 'tool_finished'
    ]);
    expect(toolEvents[0].payload).toEqual({
      tool_call_id: 'call-1',
      tool_name: 'shell',
      input_summary: '{"command":"pwd"}'
    });
    expect(toolEvents[1].payload).toEqual({
      tool_call_id: 'call-1',
      status: 'completed',
      output_summary: '/tmp/demo\n'
    });
    expect(toolEvents[3].payload).toEqual({
      tool_call_id: 'call-2',
      status: 'failed',
      output_summary: 'exit 1'
    });
  });

  it('gère les JSON malformés dans stderr sans crash', () => {
    driver.start(runSpec(worktree), 'Test');
    proc.stderr.emit('data', Buffer.from('Invalid JSON\n'));
    proc.emit('close', 0);

    expect(events.some(event => event.type === 'stderr')).toBe(true);
    expect(events.at(-1).type).toBe('completed');
  });

  it('ne déclare que les capacités prouvées', () => {
    const capabilities = driver.capabilities();
    expect(capabilities).toEqual(['process', 'stream']);
  });
});