import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeCodeCliDriver } from '../../src/worker/claude-code-cli-driver.js';

function fakeProcess(pid = 4343) {
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

describe('ClaudeCodeCliDriver', () => {
  let worktree;
  let proc;
  let calls;
  let events;
  let driver;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'claude-driver-'));
    proc = fakeProcess();
    calls = [];
    events = [];
    driver = new ClaudeCodeCliDriver({
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

  it('lance Claude en stream-json et normalise texte, outils et preuves', () => {
    const handle = driver.start(runSpec(worktree), 'Corrige le module');

    expect(calls[0].command).toBe('claude');
    expect(calls[0].args).toEqual([
      '-p', 'Corrige le module', '--output-format', 'stream-json', '--verbose'
    ]);
    expect(calls[0].args).not.toContain('--dangerously-skip-permissions');

    proc.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init","session_id":"session-claude-123"}\n'));
    proc.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"content":[{"type":"text","text":"Je corrige"},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"a.js"}}]}}\n'));
    proc.stdout.emit('data', Buffer.from('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok","is_error":false}]}}\n'));
    proc.stdout.emit('data', Buffer.from('{"type":"result","subtype":"success","result":"done"}\n'));
    proc.emit('close', 0);

    expect(handle.native_session_id).toBe('session-claude-123');
    expect(handle.status).toBe('completed');
    expect(events.map(event => event.type)).toEqual([
      'started', 'stdout', 'tool_started', 'tool_finished', 'artifact_created', 'completed'
    ]);
    expect(events[1].payload).toEqual({ content: 'Je corrige', truncated: false });
    expect(events[2].payload).toEqual({
      tool_call_id: 'toolu_1',
      tool_name: 'Read',
      input_summary: '{"file_path":"a.js"}'
    });
    expect(events[3].payload).toEqual({
      tool_call_id: 'toolu_1',
      status: 'completed',
      output_summary: 'ok'
    });

    const artifact = handle.artifacts[0];
    expect(artifact.kind).toBe('session-export');
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(artifact.path)).toBe(true);
  });

  it('normalise une erreur tool_result et un exit non nul', () => {
    driver.start(runSpec(worktree), 'Test');
    proc.stdout.emit('data', Buffer.from('{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"denied","is_error":true}]}}\n'));
    proc.emit('close', 1);

    expect(events[1].type).toBe('tool_finished');
    expect(events[1].payload.status).toBe('failed');
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
