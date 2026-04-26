import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startPg, stopPg, truncateTeam } from '../_helpers/pg.js';

const RUN = process.env.TEST_PG === '1';
const d = RUN ? describe : describe.skip;

d('routes-team', () => {
  let app, project, storage, key;
  let createRouter, initMasterDatabase, createProject, insertDevBot, updateDevBotOwner;

  beforeAll(async () => {
    await startPg();
    // Dynamic imports so the pg pool reads the env vars set by startPg.
    ({ createRouter } = await import('../../src/server/routes.js'));
    ({ initMasterDatabase, createProject } = await import('../../src/server/db.js'));
    ({ insertDevBot, updateDevBotOwner } = await import('../../src/server/dev-bots.js'));
  });
  afterAll(async () => { await stopPg(); });

  beforeEach(async () => {
    await truncateTeam();
    storage = mkdtempSync(join(tmpdir(), 'devpanel-routes-team-'));
    initMasterDatabase(storage);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    key = project.api_key;
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: storage }));
  });

  async function seedBot(label, owner) {
    const id = await insertDevBot({
      bot_token: `T-${label}`, bot_username: `${label}_bot`, bot_label: label,
      paired_by_tg_user_id: 5663177530n
    });
    await updateDevBotOwner(id, { owner_tg_user_id: owner, owner_first_name: label });
    return id;
  }

  it('GET /api/team is empty by default', async () => {
    const r = await supertest(app).get('/api/team').set('X-API-Key', key);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ members: [], routing: [] });
  });

  it('POST /api/team/members creates a member', async () => {
    const botId = await seedBot('alex', 100n);
    const r = await supertest(app)
      .post('/api/team/members')
      .set('X-API-Key', key)
      .send({ display_name: 'Alex', dev_bot_id: botId });
    expect(r.status).toBe(201);
    expect(r.body.display_name).toBe('Alex');
    expect(r.body.dev_bot.label).toBe('alex');
    expect(r.body.tg_user_id).toBe('100');
  });

  it('POST /api/team/members 400 if dev_bot_id is missing', async () => {
    const r = await supertest(app)
      .post('/api/team/members')
      .set('X-API-Key', key)
      .send({ display_name: 'X' });
    expect(r.status).toBe(400);
  });

  it('PUT /api/team/routing replaces transactionally', async () => {
    const botA = await seedBot('a', 1n);
    const botB = await seedBot('b', 2n);
    const ma = (await supertest(app).post('/api/team/members').set('X-API-Key', key)
                  .send({ display_name: 'A', dev_bot_id: botA })).body;
    const mb = (await supertest(app).post('/api/team/members').set('X-API-Key', key)
                  .send({ display_name: 'B', dev_bot_id: botB })).body;
    let r = await supertest(app).put('/api/team/routing').set('X-API-Key', key)
      .send([{ label: 'pedago', member_id: ma.id }, { label: 'com', member_id: mb.id }]);
    expect(r.status).toBe(200);
    r = await supertest(app).get('/api/team').set('X-API-Key', key);
    expect(r.body.routing.map(x => x.label).sort()).toEqual(['com', 'pedago']);
    r = await supertest(app).put('/api/team/routing').set('X-API-Key', key)
      .send([{ label: 'campus', member_id: ma.id }]);
    expect(r.status).toBe(200);
    r = await supertest(app).get('/api/team').set('X-API-Key', key);
    expect(r.body.routing.map(x => x.label)).toEqual(['campus']);
  });

  it('GET /api/team/labels returns label + member_name', async () => {
    const botA = await seedBot('alex', 1n);
    const ma = (await supertest(app).post('/api/team/members').set('X-API-Key', key)
                  .send({ display_name: 'Alex', dev_bot_id: botA })).body;
    await supertest(app).put('/api/team/routing').set('X-API-Key', key)
      .send([{ label: 'com', member_id: ma.id }]);
    const r = await supertest(app).get('/api/team/labels').set('X-API-Key', key);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([{ label: 'com', member_name: 'Alex' }]);
  });

  it('rejects without project key', async () => {
    const r = await supertest(app).get('/api/team');
    expect(r.status).toBe(401);
  });
});
