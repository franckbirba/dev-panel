import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPg, stopPg, truncateTeam } from '../_helpers/pg.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('POST /api/tickets/:id/route', () => {
  let app, storage, project, key, ticketId;
  let createRouter;
  let initMasterDatabase, createProject, initProjectDatabase, createTicket;
  let insertDevBot, updateDevBotOwner;
  let addMember, setRoutingForProject;

  beforeAll(async () => {
    await startPg();
    ({ createRouter } = await import('../../src/server/routes.js'));
    ({ initMasterDatabase, createProject, initProjectDatabase, createTicket } =
      await import('../../src/server/db.js'));
    ({ insertDevBot, updateDevBotOwner } = await import('../../src/server/dev-bots.js'));
    ({ addMember, setRoutingForProject } = await import('../../src/server/team.js'));
  }, 60000);

  afterAll(async () => { await stopPg(); });

  beforeEach(async () => {
    await truncateTeam();
    storage = mkdtempSync(join(tmpdir(), 'devpanel-route-route-'));
    initMasterDatabase(storage);
    project = createProject({ name: 'p', github_owner: 'o', github_repo: 'r' });
    key = project.api_key;
    initProjectDatabase(storage, project.id);
    const botId = await insertDevBot({
      bot_token: 'T', bot_username: 'alex_bot', bot_label: 'alex',
      paired_by_tg_user_id: 1n
    });
    await updateDevBotOwner(botId, { owner_tg_user_id: 999n, owner_first_name: 'Alex' });
    const m = await addMember({ project_id: project.id, display_name: 'Alex', dev_bot_id: botId });
    await setRoutingForProject(project.id, [{ label: 'com', member_id: m.id }]);
    ticketId = createTicket(storage, project.id, {
      type: 'bug', title: 't', description: 'd'
    });
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: storage }));
  });

  it('routes a ticket and returns member + dev_bot', async () => {
    const r = await supertest(app)
      .post(`/api/tickets/${ticketId}/route`)
      .set('X-API-Key', key)
      .send({ label: 'com' });
    expect(r.status).toBe(200);
    expect(r.body.already_routed).toBe(false);
    expect(r.body.dev_bot.label).toBe('alex');
  });

  it('is idempotent', async () => {
    await supertest(app).post(`/api/tickets/${ticketId}/route`).set('X-API-Key', key).send({ label: 'com' });
    const r = await supertest(app).post(`/api/tickets/${ticketId}/route`).set('X-API-Key', key).send({ label: 'com' });
    expect(r.body.already_routed).toBe(true);
  });

  it('409 when label has no member', async () => {
    const r = await supertest(app).post(`/api/tickets/${ticketId}/route`).set('X-API-Key', key).send({ label: 'nope' });
    expect(r.status).toBe(409);
  });

  it('404 when ticket does not exist', async () => {
    const r = await supertest(app).post('/api/tickets/99999/route').set('X-API-Key', key).send({ label: 'com' });
    expect(r.status).toBe(404);
  });
});
