import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { upsertSubject } from '../../src/server/subjects.js';
import { listMessages, getOrCreateThread } from '../../src/server/threads.js';
import { handleThreadAppend } from '../../src/mcp/server.js';

describe('MCP thread_append', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-mcp-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 't' });
  });

  it('appends a tagged message to the right thread', async () => {
    const result = await handleThreadAppend({
      raw_text: '[thread:work_item/WI-1] yeah I see it',
      role: 'shelly',
      telegram_message_id: 1234
    });
    expect(result.appended).toBe(true);
    const thread = getOrCreateThread('work_item', 'WI-1');
    const msgs = listMessages(thread.thread_id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('yeah I see it');
    expect(msgs[0].source).toBe('telegram');
  });

  it('refuses untagged text', async () => {
    const result = await handleThreadAppend({
      raw_text: 'no tag here', role: 'shelly', telegram_message_id: 1
    });
    expect(result.appended).toBe(false);
    expect(result.reason).toMatch(/no tag/i);
  });

  it('dedupes on telegram_message_id', async () => {
    await handleThreadAppend({ raw_text: '[thread:work_item/WI-1] a', role: 'shelly', telegram_message_id: 99 });
    await handleThreadAppend({ raw_text: '[thread:work_item/WI-1] a', role: 'shelly', telegram_message_id: 99 });
    const thread = getOrCreateThread('work_item', 'WI-1');
    expect(listMessages(thread.thread_id)).toHaveLength(1);
  });
});
