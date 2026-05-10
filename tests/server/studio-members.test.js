// tests/server/studio-members.test.js
// Coverage for the studio_members data layer: identity + capability +
// destination per human, used by HITL routing and authz.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateStudioMembers } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('studio-members', () => {
  let sm;

  beforeAll(async () => {
    await startPg();
    sm = await import('../../src/server/studio-members.js');
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateStudioMembers());

  it('upsertMember inserts a fresh row', async () => {
    const row = await sm.upsertMember({
      tg_user_id: 5663177530n,
      display_name: 'Franck',
      bot_label: 'franck',
      projects: ['DEVPA', 'ZENO', 'EDMS'],
      roles: ['founder', 'tech-lead'],
      can_deploy: true,
      can_approve_merge: true,
      default_dm_chat_id: 5663177530n,
    });
    expect(row.tg_user_id).toBe('5663177530');
    expect(row.display_name).toBe('Franck');
    expect(row.projects).toEqual(['DEVPA', 'ZENO', 'EDMS']);
    expect(row.can_deploy).toBe(true);
  });

  it('upsertMember updates on conflict (tg_user_id PK)', async () => {
    await sm.upsertMember({
      tg_user_id: 100n,
      display_name: 'Edwin',
      bot_label: 'edwin',
      projects: ['ZENO'],
      roles: ['dev'],
      can_deploy: false,
      can_approve_merge: false,
      default_dm_chat_id: 100n,
    });
    const updated = await sm.upsertMember({
      tg_user_id: 100n,
      display_name: 'Edwin',
      bot_label: 'edwin',
      projects: ['ZENO', 'EDMS'],
      roles: ['dev', 'design'],
      can_deploy: true,
      can_approve_merge: false,
      default_dm_chat_id: 100n,
    });
    expect(updated.projects).toEqual(['ZENO', 'EDMS']);
    expect(updated.can_deploy).toBe(true);
    const all = await sm.listMembers();
    expect(all).toHaveLength(1);
  });

  it('getByTgUserId returns null when missing', async () => {
    const r = await sm.getByTgUserId(99999n);
    expect(r).toBeNull();
  });

  it('getByBotLabel finds the member by label', async () => {
    await sm.upsertMember({
      tg_user_id: 200n,
      display_name: 'Alex',
      bot_label: 'alex',
      projects: ['EDMS'],
      roles: ['dev'],
      can_deploy: false,
      can_approve_merge: false,
      default_dm_chat_id: 200n,
    });
    const found = await sm.getByBotLabel('alex');
    expect(found?.display_name).toBe('Alex');
    expect(await sm.getByBotLabel('ghost')).toBeNull();
  });

  it('listMembers returns all members ordered by display_name', async () => {
    await sm.upsertMember({
      tg_user_id: 1n, display_name: 'Charlie', bot_label: 'charlie',
      projects: [], roles: [], can_deploy: false, can_approve_merge: false,
      default_dm_chat_id: 1n,
    });
    await sm.upsertMember({
      tg_user_id: 2n, display_name: 'Alice', bot_label: 'alice',
      projects: [], roles: [], can_deploy: false, can_approve_merge: false,
      default_dm_chat_id: 2n,
    });
    const all = await sm.listMembers();
    expect(all.map(r => r.display_name)).toEqual(['Alice', 'Charlie']);
  });

  it('listDeployers returns only members with can_deploy=true', async () => {
    await sm.upsertMember({
      tg_user_id: 1n, display_name: 'Franck', bot_label: 'franck',
      projects: ['DEVPA'], roles: [], can_deploy: true, can_approve_merge: true,
      default_dm_chat_id: 1n,
    });
    await sm.upsertMember({
      tg_user_id: 2n, display_name: 'Edwin', bot_label: 'edwin',
      projects: ['ZENO'], roles: [], can_deploy: false, can_approve_merge: false,
      default_dm_chat_id: 2n,
    });
    const deployers = await sm.listDeployers();
    expect(deployers).toHaveLength(1);
    expect(deployers[0].display_name).toBe('Franck');
  });

  it('listMembersOnProject returns members whose projects[] contains the slug', async () => {
    await sm.upsertMember({
      tg_user_id: 1n, display_name: 'Franck', bot_label: 'franck',
      projects: ['DEVPA', 'ZENO'], roles: [], can_deploy: true, can_approve_merge: true,
      default_dm_chat_id: 1n,
    });
    await sm.upsertMember({
      tg_user_id: 2n, display_name: 'Edwin', bot_label: 'edwin',
      projects: ['ZENO'], roles: [], can_deploy: false, can_approve_merge: false,
      default_dm_chat_id: 2n,
    });
    await sm.upsertMember({
      tg_user_id: 3n, display_name: 'Alex', bot_label: 'alex',
      projects: ['EDMS'], roles: [], can_deploy: false, can_approve_merge: false,
      default_dm_chat_id: 3n,
    });
    const onZeno = await sm.listMembersOnProject('ZENO');
    expect(onZeno.map(r => r.display_name).sort()).toEqual(['Edwin', 'Franck']);
    const onEdms = await sm.listMembersOnProject('EDMS');
    expect(onEdms.map(r => r.display_name)).toEqual(['Alex']);
  });

  it('removeMember deletes the row', async () => {
    await sm.upsertMember({
      tg_user_id: 42n, display_name: 'Temp', bot_label: 'temp',
      projects: [], roles: [], can_deploy: false, can_approve_merge: false,
      default_dm_chat_id: 42n,
    });
    expect(await sm.removeMember(42n)).toBe(true);
    expect(await sm.getByTgUserId(42n)).toBeNull();
    expect(await sm.removeMember(42n)).toBe(false);
  });

  it('isAuthorized checks the right capability', async () => {
    await sm.upsertMember({
      tg_user_id: 1n, display_name: 'Franck', bot_label: 'franck',
      projects: ['DEVPA'], roles: [], can_deploy: true, can_approve_merge: true,
      default_dm_chat_id: 1n,
    });
    await sm.upsertMember({
      tg_user_id: 2n, display_name: 'Edwin', bot_label: 'edwin',
      projects: ['ZENO'], roles: [], can_deploy: false, can_approve_merge: false,
      default_dm_chat_id: 2n,
    });
    expect(await sm.isAuthorized(1n, 'deploy')).toBe(true);
    expect(await sm.isAuthorized(2n, 'deploy')).toBe(false);
    expect(await sm.isAuthorized(1n, 'approve_merge')).toBe(true);
    expect(await sm.isAuthorized(2n, 'approve_merge')).toBe(false);
    expect(await sm.isAuthorized(99n, 'deploy')).toBe(false);
  });
});
