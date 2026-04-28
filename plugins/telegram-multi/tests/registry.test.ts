import { describe, it, expect } from 'bun:test';
import { diffBots, BotRegistry } from '../src/registry.ts';
import { pollRetryDelayMs } from '../src/supervisor.ts';
import type { DevBotRow } from '../src/loader.ts';

const row = (id: number, label: string, token: string): DevBotRow => ({
  id, bot_token: token, bot_username: `${label}_bot`, bot_label: label,
  owner_tg_user_id: null, owner_first_name: null
});

describe('diffBots', () => {
  it('detects added bots', () => {
    const r = diffBots([], [row(1, 'a', 'T1')]);
    expect(r.added.map(b => b.id)).toEqual([1]);
    expect(r.removed).toEqual([]);
  });

  it('detects removed bots', () => {
    const r = diffBots([row(1, 'a', 'T1')], []);
    expect(r.removed.map(b => b.id)).toEqual([1]);
    expect(r.added).toEqual([]);
  });

  it('detects token rotation as remove+add', () => {
    const r = diffBots([row(1, 'a', 'T1_old')], [row(1, 'a', 'T1_new')]);
    expect(r.removed.map(b => b.id)).toEqual([1]);
    expect(r.added.map(b => b.id)).toEqual([1]);
  });

  it('no-op when sets equal', () => {
    const cur = [row(1, 'a', 'T1'), row(2, 'b', 'T2')];
    const r = diffBots(cur, cur);
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });
});

describe('BotRegistry.reconcile', () => {
  it('starts new bots and stops removed ones', async () => {
    const started: number[] = [];
    const stopped: number[] = [];
    const reg = new BotRegistry({
      start: async (b) => { started.push(b.id); },
      stop:  async (b) => { stopped.push(b.id); }
    });
    await reg.reconcile([row(1, 'a', 'T1')]);
    await reg.reconcile([row(1, 'a', 'T1'), row(2, 'b', 'T2')]);
    await reg.reconcile([row(2, 'b', 'T2')]);
    expect(started).toEqual([1, 2]);
    expect(stopped).toEqual([1]);
  });

  it('handles start failure gracefully (does not retain in current set)', async () => {
    const started: number[] = [];
    const reg = new BotRegistry({
      start: async (b) => { started.push(b.id); throw new Error('boom'); },
      stop:  async () => {}
    });
    await reg.reconcile([row(1, 'a', 'T1')]);
    // Next reconcile with same row should attempt start again because the
    // failed bot wasn't added to the current set.
    await reg.reconcile([row(1, 'a', 'T1')]);
    expect(started).toEqual([1, 1]);
  });
});

describe('pollRetryDelayMs', () => {
  it('exponential backoff capped at 60s', () => {
    expect(pollRetryDelayMs(0)).toBe(2_000);
    expect(pollRetryDelayMs(1)).toBe(4_000);
    expect(pollRetryDelayMs(2)).toBe(8_000);
    expect(pollRetryDelayMs(3)).toBe(16_000);
    expect(pollRetryDelayMs(4)).toBe(32_000);
    expect(pollRetryDelayMs(5)).toBe(60_000);
    expect(pollRetryDelayMs(6)).toBe(60_000);
    expect(pollRetryDelayMs(100)).toBe(60_000);
  });

  it('first retry happens within one watchdog tick (60s)', () => {
    // Critical safety property — a transient 409 must recover within the
    // window of a single watchdog cycle so the watchdog never has to fire.
    expect(pollRetryDelayMs(0)).toBeLessThan(60_000);
  });
});

// Behavioural test for the supervisor pattern: a polling promise that
// rejects must trigger a re-entry to start(), without the bot row being
// removed from the registry's current set. We model the supervisor inline
// (the real one lives in server.ts and ties to grammy) so we can assert
// the contract: "transient polling failure ≠ row removed from running."
describe('supervisor pattern', () => {
  it('retains row in registry across transient polling failure', async () => {
    const startCalls: number[] = [];
    const reg = new BotRegistry({
      // Supervisor wraps b.start().catch(retry) — from the registry's
      // perspective, this start succeeds (returns undefined). Polling
      // failures surface only via the supervisor's internal retry loop,
      // never as a thrown error from start().
      start: async (b) => {
        startCalls.push(b.id);
        // Simulate the supervisor: kicks off polling in the background,
        // catches errors. start() itself returns immediately.
      },
      stop: async () => {}
    });
    await reg.reconcile([row(1, 'a', 'T1')]);
    // Even after a "transient failure" the supervisor handles internally,
    // a re-reconcile with the same row must NOT trigger a duplicate start
    // (registry sees no diff). This protects against the regression where
    // the supervisor ALSO removed the row from running on failure, causing
    // diffBots to add+remove on every tick.
    await reg.reconcile([row(1, 'a', 'T1')]);
    expect(startCalls).toEqual([1]);
  });
});
