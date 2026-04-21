import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject } from '../../src/server/db.js';
import { upsertSubject } from '../../src/server/subjects.js';
import {
  getOrCreateThread, listMessages, appendMessage, appendFromTelegram
} from '../../src/server/threads.js';

describe('threads', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-thr-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'demo', github_owner: 'o', github_repo: 'r' });
    upsertSubject({ subject_type: 'work_item', subject_id: 'WI-1', project_id: project.id, title: 't' });
  });

  it('getOrCreateThread is lazy and idempotent', () => {
    const t1 = getOrCreateThread('work_item', 'WI-1');
    const t2 = getOrCreateThread('work_item', 'WI-1');
    expect(t1.thread_id).toBe(t2.thread_id);
    expect(t1.subject_type).toBe('work_item');
    expect(t1.project_id).toBe(project.id);
  });

  it('appendMessage stores a row and bumps last_message_at', async () => {
    const t = getOrCreateThread('work_item', 'WI-1');
    await new Promise(r => setTimeout(r, 5)); // ensure timestamp diff
    appendMessage({ thread_id: t.thread_id, role: 'user', source: 'web', content: 'hi' });
    const msgs = listMessages(t.thread_id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'user', source: 'web', content: 'hi' });
  });

  it('appendFromTelegram dedupes on telegram_message_id', () => {
    const t = getOrCreateThread('work_item', 'WI-1');
    appendFromTelegram({ thread_id: t.thread_id, role: 'shelly', content: 'a', telegram_message_id: 42 });
    appendFromTelegram({ thread_id: t.thread_id, role: 'shelly', content: 'a', telegram_message_id: 42 });
    expect(listMessages(t.thread_id)).toHaveLength(1);
  });

  it('listMessages returns rows in created_at + id order', () => {
    const t = getOrCreateThread('work_item', 'WI-1');
    appendMessage({ thread_id: t.thread_id, role: 'user',   source: 'web', content: '1' });
    appendMessage({ thread_id: t.thread_id, role: 'shelly', source: 'telegram', content: '2' });
    appendMessage({ thread_id: t.thread_id, role: 'system', source: 'system', content: '3' });
    const order = listMessages(t.thread_id).map(m => m.content);
    expect(order).toEqual(['1', '2', '3']);
  });

  it('rejects invalid role / source', () => {
    const t = getOrCreateThread('work_item', 'WI-1');
    expect(() => appendMessage({ thread_id: t.thread_id, role: 'bot', source: 'web', content: 'x' }))
      .toThrow(/invalid role/);
    expect(() => appendMessage({ thread_id: t.thread_id, role: 'user', source: 'sms', content: 'x' }))
      .toThrow(/invalid source/);
  });
});
