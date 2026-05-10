// tests/server/notify-routing.test.js
// Coverage for notify-routing config + resolver. Routes 6 event kinds
// today; resolver picks recipient ids from studio_members.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateStudioMembers } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('notify-routing', () => {
  let routing, studio;

  beforeAll(async () => {
    await startPg();
    routing = await import('../../src/server/notify-routing.js');
    studio = await import('../../src/server/studio-members.js');
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(async () => {
    await truncateStudioMembers();
    await studio.upsertMember({
      tg_user_id: 1n, display_name: 'Franck', bot_label: 'franck',
      projects: ['DEVPA', 'ZENO', 'EDMS'], roles: ['founder'],
      can_deploy: true, can_approve_merge: true, default_dm_chat_id: 1n,
    });
    await studio.upsertMember({
      tg_user_id: 2n, display_name: 'Edwin', bot_label: 'edwin',
      projects: ['ZENO'], roles: ['dev'],
      can_deploy: false, can_approve_merge: false, default_dm_chat_id: 2n,
    });
    await studio.upsertMember({
      tg_user_id: 3n, display_name: 'Alex', bot_label: 'alex',
      projects: ['EDMS'], roles: ['dev'],
      can_deploy: false, can_approve_merge: false, default_dm_chat_id: 3n,
    });
  });

  it('ROUTES table covers the documented 6 studio-fact + 3 personal kinds', () => {
    const kinds = Object.keys(routing.ROUTES);
    expect(kinds).toContain('morning_digest');
    expect(kinds).toContain('deploy');
    expect(kinds).toContain('pr_shipped');
    expect(kinds).toContain('glitchtip_error');
    expect(kinds).toContain('capture_promoted');
    expect(kinds).toContain('workflow_completed');
    expect(kinds).toContain('await_human');
    expect(kinds).toContain('tool_approval');
  });

  it('resolveRecipients all_active returns every member', async () => {
    const ids = await routing.resolveRecipients({
      kind: 'morning_digest', payload: {}, studio,
    });
    expect(ids.sort()).toEqual(['1', '2', '3']);
  });

  it('resolveRecipients all_with_can_deploy returns deployers only', async () => {
    const ids = await routing.resolveRecipients({
      kind: 'deploy', payload: {}, studio,
    });
    expect(ids).toEqual(['1']);
  });

  it('resolveRecipients project_members filters by project slug', async () => {
    const zeno = await routing.resolveRecipients({
      kind: 'pr_shipped', payload: { project: 'ZENO' }, studio,
    });
    expect(zeno.sort()).toEqual(['1', '2']);
    const edms = await routing.resolveRecipients({
      kind: 'pr_shipped', payload: { project: 'EDMS' }, studio,
    });
    expect(edms.sort()).toEqual(['1', '3']);
  });

  it('resolveRecipients requester returns single id from payload', async () => {
    const ids = await routing.resolveRecipients({
      kind: 'await_human', payload: { requester_tg_user_id: 2 }, studio,
    });
    expect(ids).toEqual(['2']);
  });

  it('resolveRecipients returns [] when project_members has no project', async () => {
    const ids = await routing.resolveRecipients({
      kind: 'pr_shipped', payload: {}, studio,
    });
    expect(ids).toEqual([]);
  });

  it('resolveRecipients pair_dev_bot resolves bot_label to Franck', async () => {
    const ids = await routing.resolveRecipients({
      kind: 'pair_dev_bot', payload: {}, studio,
    });
    expect(ids).toEqual(['1']);
  });

  it('resolveRecipients returns [] for unknown kind', async () => {
    const ids = await routing.resolveRecipients({
      kind: 'bogus', payload: {}, studio,
    });
    expect(ids).toEqual([]);
  });

  it('resolveDestinations returns chat_id alongside tg_user_id', async () => {
    const dests = await routing.resolveDestinations({
      kind: 'pr_shipped', payload: { project: 'EDMS' }, studio,
    });
    expect(dests).toHaveLength(2);
    const byName = Object.fromEntries(dests.map(d => [d.display_name, d.chat_id]));
    expect(byName.Franck).toBe('1');
    expect(byName.Alex).toBe('3');
  });
});
