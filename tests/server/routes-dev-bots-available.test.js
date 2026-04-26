import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { startPg, stopPg, truncateTeam } from '../_helpers/pg.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('GET /api/dev-bots/available', () => {
  let app;
  let mountDevBotsRoutes, insertDevBot, updateDevBotOwner, addMember;

  beforeAll(async () => {
    await startPg();
    ({ mountDevBotsRoutes } = await import('../../src/server/routes-dev-bots.js'));
    ({ insertDevBot, updateDevBotOwner } = await import('../../src/server/dev-bots.js'));
    ({ addMember } = await import('../../src/server/team.js'));
  });
  afterAll(async () => { await stopPg(); });

  beforeEach(async () => {
    await truncateTeam();
    app = express();
    app.use(express.json());
    mountDevBotsRoutes(app);
  });

  it('returns active bots not yet linked to a member of the project', async () => {
    const a = await insertDevBot({
      bot_token: 'TA', bot_username: 'a_bot', bot_label: 'a',
      paired_by_tg_user_id: 1n
    });
    await updateDevBotOwner(a, { owner_tg_user_id: 100n, owner_first_name: 'A' });
    const b = await insertDevBot({
      bot_token: 'TB', bot_username: 'b_bot', bot_label: 'b',
      paired_by_tg_user_id: 1n
    });
    await updateDevBotOwner(b, { owner_tg_user_id: 200n, owner_first_name: 'B' });
    await addMember({ project_id: 'p1', display_name: 'A-member', dev_bot_id: a });
    const r = await supertest(app).get('/api/dev-bots/available?project=p1');
    expect(r.status).toBe(200);
    expect(r.body.map(x => x.bot_label)).toEqual(['b']);
    const r2 = await supertest(app).get('/api/dev-bots/available?project=p2');
    expect(r2.body.map(x => x.bot_label).sort()).toEqual(['a', 'b']);
  });

  it('400 if project query is missing', async () => {
    const r = await supertest(app).get('/api/dev-bots/available');
    expect(r.status).toBe(400);
  });
});
