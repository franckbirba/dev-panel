import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, closeAllDatabases } from '../../src/server/db.js';

describe('agent node enrollment routes', () => {
  let app;
  const adminKey = 'admin_test_key';

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-nodes-'));
    initMasterDatabase(tmp);
    process.env.ADMIN_API_KEY = adminKey;
    process.env.NODE_ENV = 'test';
    const { createRouter } = await import('../../src/server/routes.js');
    app = express();
    app.use(express.json());
    app.use('/api', createRouter({ storagePath: tmp }));
  });

  afterEach(() => {
    closeAllDatabases();
  });

  it('requires admin auth', async () => {
    const response = await request(app).post('/api/admin/agent-nodes').send({ name: 'mac-franck' });
    expect(response.status).toBe(401);
  });

  it('enrolls a node and issues a scoped task token', async () => {
    const enrolled = await request(app)
      .post('/api/admin/agent-nodes')
      .set('X-Admin-Key', adminKey)
      .send({ name: 'mac-franck' });
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.node_id).toBeDefined();
    expect(enrolled.body.token).toHaveLength(64);

    const issued = await request(app)
      .post('/api/admin/agent-task-tokens')
      .set('X-Admin-Key', adminKey)
      .send({
        node_id: enrolled.body.node_id,
        task_id: 'demo-task',
        repository: 'franckbirba/dev-panel',
        branch: 'feat/demo',
        expires_in_seconds: 900
      });
    expect(issued.status).toBe(201);
    expect(issued.body).toMatchObject({
      task_id: 'demo-task',
      repository: 'franckbirba/dev-panel',
      branch: 'feat/demo',
      expires_in_seconds: 900
    });
    expect(issued.body.token).toHaveLength(64);
    expect(issued.body.token).not.toBe(enrolled.body.token);
  });

  it('rejects invalid task scopes', async () => {
    const enrolled = await request(app)
      .post('/api/admin/agent-nodes')
      .set('X-Admin-Key', adminKey)
      .send({ name: 'mac-franck' });
    const issued = await request(app)
      .post('/api/admin/agent-task-tokens')
      .set('X-Admin-Key', adminKey)
      .send({ node_id: enrolled.body.node_id, task_id: 'demo', repository: 'invalid', branch: 'main' });
    expect(issued.status).toBe(400);
  });
});
