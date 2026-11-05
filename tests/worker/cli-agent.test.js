import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnCliAgent } from '../../src/worker/cli-agent.js';

function fakeProcess() {
  const proc = new EventEmitter();
  proc.pid = 4545;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    queueMicrotask(() => proc.emit('close', 143));
    return true;
  };
  return proc;
}

describe('spawnCliAgent', () => {
  let worktree;
  let proc;
  let activeProcesses;
  let appended;
  let spawnImpl;

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'cli-agent-'));
    proc = fakeProcess();
    activeProcesses = new Map();
    appended = [];
    spawnImpl = () => proc;
  });

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true });
  });

  it('utilise Kimi, persiste les événements et résout le texte assistant', async () => {
    const result = await (async () => {
      const pending = spawnCliAgent({
        driverName: 'kimi-code-cli',
        jobId: 'job-kimi',
        prompt: 'OK',
        cwd: worktree,
        activeProcesses,
        appendEvent: async event => { appended.push(event); },
        spawnImpl
      });
      proc.stdout.emit('data', Buffer.from('{"role":"assistant","content":"OK"}\n'));
      proc.emit('close', 0);
      return pending;
    })();

    expect(result).toBe('OK');
    expect(activeProcesses.size).toBe(0);
    expect(appended.map(event => event.event_type)).toEqual([
      'started', 'stdout', 'artifact_created', 'completed'
    ]);
    expect(appended.every(event => event.job_id === 'job-kimi')).toBe(true);
    expect(appended.map(event => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it('utilise Claude et rejette un exit non nul', async () => {
    const pending = spawnCliAgent({
      driverName: 'claude-code-cli',
      jobId: 'job-claude',
      prompt: 'Test',
      cwd: worktree,
      activeProcesses,
      appendEvent: async event => { appended.push(event); },
      spawnImpl
    });
    proc.emit('close', 1);

    await expect(pending).rejects.toThrow('Claude Code CLI exited with code 1');
    expect(activeProcesses.size).toBe(0);
  });

  it('rejette un driver inconnu avant tout spawn', async () => {
    await expect(spawnCliAgent({
      driverName: 'other-cli',
      jobId: 'job-other',
      prompt: 'Test',
      cwd: worktree,
      activeProcesses,
      appendEvent: async () => {},
      spawnImpl
    })).rejects.toThrow('Unsupported CLI driver: other-cli');
  });
});
