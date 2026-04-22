import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';
import { upsertSubject } from '../../src/server/subjects.js';
import { getOrCreateThread } from '../../src/server/threads.js';
import { createRouter } from '../../src/server/routes.js';
import { handleThreadAppend } from '../../src/mcp/server.js';

describe('MCP thread_append', () => {
  let project, server, origApiBase, origAdminKey;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-mcp-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 't' });

    // Boot a tiny express app exposing /api/* so handleThreadAppend can POST to it.
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/api', createRouter({ storagePath: tmp }));
    server = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    origApiBase = process.env.API_BASE;
    origAdminKey = process.env.ADMIN_API_KEY;
    process.env.API_BASE = `http://127.0.0.1:${port}`;
    process.env.ADMIN_API_KEY = 'test-admin-key';
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
    process.env.API_BASE = origApiBase;
    process.env.ADMIN_API_KEY = origAdminKey;
  });

  it('appends a tagged message to the right thread via the HTTP API', async () => {
    const result = await handleThreadAppend({
      raw_text: '[thread:work_item/WI-1] yeah I see it',
      role: 'shelly',
      telegram_message_id: 1234
    });
    expect(result.appended).toBe(true);

    const db = getMasterDatabase();
    const thread = getOrCreateThread('work_item', 'WI-1');
    const msgs = db.prepare(
      `SELECT role, source, content, telegram_message_id FROM thread_messages WHERE thread_id=?`
    ).all(thread.thread_id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      role: 'shelly',
      source: 'telegram',
      content: 'yeah I see it',
      telegram_message_id: 1234
    });
  });

  it('refuses untagged text', async () => {
    const result = await handleThreadAppend({
      raw_text: 'no tag here', role: 'shelly', telegram_message_id: 1
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toMatch(/no tag/i);
  });

  it('returns a useful error when the subject does not exist', async () => {
    const result = await handleThreadAppend({
      raw_text: '[thread:work_item/unknown-id] hi', role: 'shelly', telegram_message_id: 7
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toMatch(/api 404|subject/i);
  });
});
