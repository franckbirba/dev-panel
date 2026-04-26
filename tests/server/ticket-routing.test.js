import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPg, stopPg, truncateTeam } from '../_helpers/pg.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('routeTicket', () => {
  let storage, project, member, botId;
  let initMasterDatabase, createProject, initProjectDatabase, createTicket;
  let insertDevBot, updateDevBotOwner;
  let addMember, setRoutingForProject;
  let routeTicket;

  beforeAll(async () => {
    await startPg();
    ({ initMasterDatabase, createProject, initProjectDatabase, createTicket } =
      await import('../../src/server/db.js'));
    ({ insertDevBot, updateDevBotOwner } = await import('../../src/server/dev-bots.js'));
    ({ addMember, setRoutingForProject } = await import('../../src/server/team.js'));
    ({ routeTicket } = await import('../../src/server/ticket-routing.js'));
  }, 60000);

  afterAll(async () => { await stopPg(); });

  beforeEach(async () => {
    await truncateTeam();
    storage = mkdtempSync(join(tmpdir(), 'devpanel-routeticket-'));
    initMasterDatabase(storage);
    project = createProject({ name: 'p', github_owner: 'o', github_repo: 'r' });
    initProjectDatabase(storage, project.id);
    botId = await insertDevBot({
      bot_token: 'T', bot_username: 'alex_bot', bot_label: 'alex',
      paired_by_tg_user_id: 1n
    });
    await updateDevBotOwner(botId, { owner_tg_user_id: 999n, owner_first_name: 'Alex' });
    member = await addMember({ project_id: project.id, display_name: 'Alex', dev_bot_id: botId });
    await setRoutingForProject(project.id, [{ label: 'com', member_id: member.id }]);
  });

  it('persists routing and returns member + dev_bot', async () => {
    const ticketId = createTicket(storage, project.id, {
      type: 'bug', title: 't', description: 'd'
    });
    const out = await routeTicket(storage, project.id, ticketId, 'com');
    expect(out.already_routed).toBe(false);
    expect(out.member.id).toBe(member.id);
    expect(out.dev_bot.label).toBe('alex');
    expect(String(out.dev_bot.tg_user_id)).toBe('999');
  });

  it('is idempotent — second call returns already_routed=true and ignores new label', async () => {
    const ticketId = createTicket(storage, project.id, {
      type: 'bug', title: 't', description: 'd'
    });
    await routeTicket(storage, project.id, ticketId, 'com');
    // Add a second routing for kicks.
    const bot2 = await insertDevBot({
      bot_token: 'T2', bot_username: 'b_bot', bot_label: 'b',
      paired_by_tg_user_id: 1n
    });
    const m2 = await addMember({ project_id: project.id, display_name: 'B', dev_bot_id: bot2 });
    await setRoutingForProject(project.id, [
      { label: 'com', member_id: member.id },
      { label: 'campus', member_id: m2.id }
    ]);
    const second = await routeTicket(storage, project.id, ticketId, 'campus');
    expect(second.already_routed).toBe(true);
    expect(second.label).toBe('com');
    expect(second.member.id).toBe(member.id);
  });

  it('returns null when label has no member', async () => {
    const ticketId = createTicket(storage, project.id, {
      type: 'bug', title: 't', description: 'd'
    });
    const out = await routeTicket(storage, project.id, ticketId, 'unknown');
    expect(out).toBeNull();
  });

  it('throws when ticket does not exist', async () => {
    await expect(routeTicket(storage, project.id, 99999, 'com')).rejects.toThrow();
  });

  it('honours pre-written routed_label (widget category wins over Shelly arg)', async () => {
    const ticketId = createTicket(storage, project.id, {
      type: 'bug', title: 't', description: 'd'
    });
    // Simulate widget pre-write at submission time.
    const { setTicketRouting } = await import('../../src/server/db.js');
    setTicketRouting(storage, project.id, ticketId, { label: 'com', member_id: null });
    // Shelly proposes a different label; the widget choice should win.
    const out = await routeTicket(storage, project.id, ticketId, 'campus');
    expect(out.label).toBe('com');
    expect(out.already_routed).toBe(false);
    expect(out.member.id).toBe(member.id);
  });
});
