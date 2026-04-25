import { describe, it, expect } from 'bun:test';
import { diffBots, BotRegistry } from '../src/registry.ts';
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
