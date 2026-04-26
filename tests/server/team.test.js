import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startPg, stopPg, truncateTeam, getPool } from '../_helpers/pg.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('team DAO', () => {
  let insertDevBot, updateDevBotOwner;
  let addMember, listMembers, updateMember, deleteMember;
  let setRoutingForProject, listRoutingForProject, listLabelsForProject, resolveLabel;

  beforeAll(async () => {
    await startPg();
    ({ insertDevBot, updateDevBotOwner } = await import('../../src/server/dev-bots.js'));
    ({
      addMember, listMembers, updateMember, deleteMember,
      setRoutingForProject, listRoutingForProject, listLabelsForProject,
      resolveLabel
    } = await import('../../src/server/team.js'));
  }, 60000);

  afterAll(async () => { await stopPg(); });
  beforeEach(async () => { await truncateTeam(); });

  async function seedBot(label, owner = 1234567n) {
    const id = await insertDevBot({
      bot_token: `T-${label}`, bot_username: `${label}_bot`, bot_label: label,
      paired_by_tg_user_id: 5663177530n
    });
    await updateDevBotOwner(id, { owner_tg_user_id: owner, owner_first_name: label });
    return id;
  }

  it('addMember stores name + dev_bot_id + denormalized tg_user_id', async () => {
    const botId = await seedBot('alex', 100n);
    const m = await addMember({ project_id: 'p1', display_name: 'Alex', dev_bot_id: botId });
    expect(m.id).toBeGreaterThan(0);
    expect(m.display_name).toBe('Alex');
    expect(m.dev_bot_id).toBe(botId);
    expect(String(m.tg_user_id)).toBe('100');
  });

  it('listMembers joins dev_bot info', async () => {
    const botId = await seedBot('geronimo', 200n);
    await addMember({ project_id: 'p1', display_name: 'Geronimo', dev_bot_id: botId });
    const out = await listMembers('p1');
    expect(out).toHaveLength(1);
    expect(out[0].dev_bot.label).toBe('geronimo');
    expect(out[0].dev_bot.username).toBe('geronimo_bot');
  });

  it('addMember rejects duplicate display_name in same project', async () => {
    const a = await seedBot('a', 1n);
    const b = await seedBot('b', 2n);
    await addMember({ project_id: 'p1', display_name: 'X', dev_bot_id: a });
    await expect(addMember({ project_id: 'p1', display_name: 'X', dev_bot_id: b }))
      .rejects.toThrow();
  });

  it('addMember rejects same dev_bot twice in same project but allows reuse across projects', async () => {
    const botId = await seedBot('alex', 100n);
    await addMember({ project_id: 'p1', display_name: 'Alex', dev_bot_id: botId });
    await expect(addMember({ project_id: 'p1', display_name: 'Alice', dev_bot_id: botId }))
      .rejects.toThrow();
    const cross = await addMember({ project_id: 'p2', display_name: 'Alex', dev_bot_id: botId });
    expect(cross.id).toBeGreaterThan(0);
  });

  it('setRoutingForProject is full-replace and transactional', async () => {
    const botA = await seedBot('a', 1n);
    const botB = await seedBot('b', 2n);
    const m1 = await addMember({ project_id: 'p1', display_name: 'A', dev_bot_id: botA });
    const m2 = await addMember({ project_id: 'p1', display_name: 'B', dev_bot_id: botB });
    await setRoutingForProject('p1', [
      { label: 'pedago', member_id: m1.id },
      { label: 'com',    member_id: m2.id }
    ]);
    let out = await listRoutingForProject('p1');
    expect(out.map(r => r.label).sort()).toEqual(['com', 'pedago']);
    // Replace with a single rule.
    await setRoutingForProject('p1', [{ label: 'campus', member_id: m1.id }]);
    out = await listRoutingForProject('p1');
    expect(out.map(r => r.label)).toEqual(['campus']);
  });

  it('setRoutingForProject rejects invalid member_id atomically', async () => {
    const botA = await seedBot('a', 1n);
    const m1 = await addMember({ project_id: 'p1', display_name: 'A', dev_bot_id: botA });
    await setRoutingForProject('p1', [{ label: 'kept', member_id: m1.id }]);
    await expect(
      setRoutingForProject('p1', [
        { label: 'pedago', member_id: m1.id },
        { label: 'broken', member_id: 999999 }
      ])
    ).rejects.toThrow();
    // Original survives — transaction rolled back.
    const out = await listRoutingForProject('p1');
    expect(out.map(r => r.label)).toEqual(['kept']);
  });

  it('listLabelsForProject returns label + member_name pairs', async () => {
    const botA = await seedBot('a', 1n);
    const m = await addMember({ project_id: 'p1', display_name: 'Alex', dev_bot_id: botA });
    await setRoutingForProject('p1', [{ label: 'com', member_id: m.id }]);
    const labels = await listLabelsForProject('p1');
    expect(labels).toEqual([{ label: 'com', member_name: 'Alex' }]);
  });

  it('resolveLabel returns member with dev_bot info or null', async () => {
    const botA = await seedBot('alex', 999n);
    const m = await addMember({ project_id: 'p1', display_name: 'Alex', dev_bot_id: botA });
    await setRoutingForProject('p1', [{ label: 'com', member_id: m.id }]);
    const hit = await resolveLabel('p1', 'com');
    expect(hit.member.display_name).toBe('Alex');
    expect(hit.dev_bot.label).toBe('alex');
    expect(String(hit.member.tg_user_id)).toBe('999');
    const miss = await resolveLabel('p1', 'unknown');
    expect(miss).toBeNull();
  });

  it('deleteMember cascades into team_routing', async () => {
    const botA = await seedBot('a', 1n);
    const m = await addMember({ project_id: 'p1', display_name: 'A', dev_bot_id: botA });
    await setRoutingForProject('p1', [{ label: 'x', member_id: m.id }]);
    await deleteMember(m.id);
    expect(await listMembers('p1')).toEqual([]);
    expect(await listRoutingForProject('p1')).toEqual([]);
  });

  it('updateMember can change name and dev_bot_id; tg_user_id refreshes', async () => {
    const botA = await seedBot('a', 1n);
    const botB = await seedBot('b', 2n);
    const m = await addMember({ project_id: 'p1', display_name: 'Old', dev_bot_id: botA });
    const updated = await updateMember(m.id, { display_name: 'New', dev_bot_id: botB });
    expect(updated.display_name).toBe('New');
    expect(updated.dev_bot_id).toBe(botB);
    expect(String(updated.tg_user_id)).toBe('2');
  });
});
