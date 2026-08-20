// tests/worker/pi-driver-spawn.test.js
//
// H6 (docs/architecture/harness-pi.md §4.2, ADR-005 H6): verifies spawnPi's
// onUsage passthrough reaches the caller with pi's live cumulative usage
// snapshots, not just at exit. Split into its own file (rather than
// pi-driver.test.js) because it needs `vi.mock('child_process')` at module
// scope — pi-driver.js itself uses child_process.spawnSync for
// synthesizePiResult's git introspection, and keeping that mock isolated
// to this file avoids any chance of it leaking into the pure-function
// tests in pi-driver.test.js (readSubmitResultEnvelope, buildPiEnv), which
// follows the same file-splitting convention as
// tests/worker/bootstrap-project.test.js.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })), // "not a git dir" for any synthesizePiResult fallback
}));
vi.mock('../../src/server/jobs-events.js', () => ({
  appendEvent: vi.fn(() => Promise.resolve()),
  broadcastDone: vi.fn(),
}));
vi.mock('../../src/worker/harness-telemetry.js', () => ({
  recordHarnessEvent: vi.fn(),
}));
vi.mock('../../src/worker/select-pi-model.js', () => ({
  selectPiModel: vi.fn(() => ({ provider: 'deepinfra', model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo' })),
}));
vi.mock('../../src/worker/prompt-builder.js', () => ({
  readSoul: vi.fn(() => 'you are a builder'),
  parseResult: vi.fn((text) => ({ ok: false, error: 'no json object found' })),
}));

describe('spawnPi onUsage', () => {
  let spawnMock;
  let agentLogDir;
  let cwd;

  beforeEach(async () => {
    const cp = await import('child_process');
    spawnMock = cp.spawn;
    spawnMock.mockReset();
    agentLogDir = mkdtempSync(join(tmpdir(), 'pi-driver-spawn-logs-'));
    cwd = mkdtempSync(join(tmpdir(), 'pi-driver-spawn-cwd-'));
  });

  function fakeProc() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    return proc;
  }

  it('invokes onUsage with each cumulative usage snapshot as pi streams assistant messages', async () => {
    const { spawnPi } = await import('../../src/worker/pi-driver.js');
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);

    const usageSnapshots = [];
    const activeProcesses = new Map();
    const resultPromise = spawnPi({
      jobId: 'job-h6-1',
      prompt: 'do the thing',
      agentRole: 'builder',
      cwd,
      activeProcesses,
      agentLogDir,
      onUsage: (usage) => usageSnapshots.push(usage),
    });

    // Simulate two assistant message_end lines with growing cumulative usage.
    proc.stdout.emit('data', Buffer.from(
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'step 1' }], usage: { input: 100, output: 20, totalTokens: 120 } },
      }) + '\n'
    ));
    proc.stdout.emit('data', Buffer.from(
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'step 2' }], usage: { input: 500, output: 200, totalTokens: 700 } },
      }) + '\n'
    ));
    proc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'agent_end', messages: [] }) + '\n'
    ));
    proc.emit('close', 0);

    await resultPromise;

    expect(usageSnapshots).toEqual([
      { input: 100, output: 20, totalTokens: 120 },
      { input: 500, output: 200, totalTokens: 700 },
    ]);
  });

  it('never throws when onUsage is omitted (backward compatible with existing callers)', async () => {
    const { spawnPi } = await import('../../src/worker/pi-driver.js');
    const proc = fakeProc();
    spawnMock.mockReturnValue(proc);

    const activeProcesses = new Map();
    const resultPromise = spawnPi({
      jobId: 'job-h6-2',
      prompt: 'do the thing',
      agentRole: 'builder',
      cwd,
      activeProcesses,
      agentLogDir,
      // no onUsage
    });

    proc.stdout.emit('data', Buffer.from(
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'step 1' }], usage: { input: 10, output: 5, totalTokens: 15 } },
      }) + '\n'
    ));
    proc.stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'agent_end', messages: [] }) + '\n'
    ));
    proc.emit('close', 0);

    await expect(resultPromise).resolves.toBeDefined();
  });
});
