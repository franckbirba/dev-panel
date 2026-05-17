// tests/worker/parent-context.test.js
//
// DEVPA-228 smoke tests: caller-controlled inheritance from a parent BullMQ
// job. Mocks the BullMQ queue (parent job lookup) and the threads module
// (thread tail). Files inheritance uses a temp dir on disk so the path-safety
// guards (no `..`, no absolute escape) are exercised for real.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const parentJobData = {
  agent: 'builder',
  workflow: 'work-item',
  plane: { work_item_id: 'DEVPA-200' },
  context: { pr_url: 'https://github.com/franckbirba/dev-panel/pull/277' }
};

vi.mock('../../src/server/bullmq.js', () => ({
  QUEUES: { agents: 'agents' },
  getQueue: () => ({
    getJob: async (id) => (id === '999' ? { data: parentJobData } : null)
  })
}));

vi.mock('../../src/server/threads.js', () => ({
  getOrCreateThread: (subject_type, subject_id) => ({
    id: 42, subject_type, subject_id
  }),
  listMessages: () => ([
    { role: 'user',   source: 'web',      content: 'first message',  created_at: '2026-05-17T10:00:00Z' },
    { role: 'shelly', source: 'telegram', content: 'second message', created_at: '2026-05-17T10:01:00Z' },
    { role: 'agent',  source: 'system',   content: 'third message',  created_at: '2026-05-17T10:02:00Z' }
  ])
}));

let resolveParentContext, renderParentContextBlock;
beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../../src/worker/parent-context.js');
  resolveParentContext = mod.resolveParentContext;
  renderParentContextBlock = mod.renderParentContextBlock;
});

describe('resolveParentContext — DEVPA-228 AC: thread_context', () => {
  it('returns null when inherit_context selects nothing', async () => {
    const out = await resolveParentContext({ parent_job_id: '999', inherit_context: {} });
    expect(out).toBeNull();
  });

  it('returns null when parent_job_id is missing', async () => {
    const out = await resolveParentContext({ inherit_context: { thread_context: true } });
    expect(out).toBeNull();
  });

  it('records an error blob when the parent job cannot be loaded', async () => {
    const out = await resolveParentContext({
      parent_job_id: 'nonexistent',
      inherit_context: { thread_context: true }
    });
    expect(out.error).toMatch(/parent job nonexistent not found/);
    expect(out.requested.thread_context).toBe(true);
  });

  it('pulls the parent thread tail and surfaces parent metadata', async () => {
    const out = await resolveParentContext({
      parent_job_id: '999',
      inherit_context: { thread_context: true }
    });
    expect(out.parent_job_id).toBe('999');
    expect(out.parent_agent).toBe('builder');
    expect(out.parent_workflow).toBe('work-item');
    expect(out.parent_work_item_id).toBe('DEVPA-200');
    expect(out.thread_context.thread_id).toBe(42);
    expect(out.thread_context.subject).toBe('work_item/DEVPA-200');
    expect(out.thread_context.message_count).toBe(3);
    expect(out.thread_context.messages).toHaveLength(3);
    expect(out.thread_context.messages[1].content).toBe('second message');
  });

  it('renders the thread tail as a markdown block', async () => {
    const out = await resolveParentContext({
      parent_job_id: '999',
      inherit_context: { thread_context: true }
    });
    const md = renderParentContextBlock(out);
    expect(md).toContain('## Parent context');
    expect(md).toContain('**Parent job:** 999');
    expect(md).toContain('### Parent thread tail');
    expect(md).toContain('first message');
    expect(md).toContain('third message');
  });
});

describe('resolveParentContext — DEVPA-228 AC: files', () => {
  it('snapshots requested files relative to the parent worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devpa228-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/foo.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'README.md'), '# parent repo\n');

    // Override parent worktree on the fly — re-mock for this test only.
    vi.doMock('../../src/server/bullmq.js', () => ({
      QUEUES: { agents: 'agents' },
      getQueue: () => ({
        getJob: async () => ({
          data: {
            ...parentJobData,
            context: { worktree_path: root }
          }
        })
      })
    }));
    vi.resetModules();
    const { resolveParentContext: fresh, renderParentContextBlock: render } =
      await import('../../src/worker/parent-context.js');

    const out = await fresh({
      parent_job_id: '999',
      inherit_context: { files: ['src/foo.ts', 'README.md', 'does-not-exist.txt'] }
    });
    expect(out.files).toHaveLength(3);
    expect(out.files[0].path).toBe('src/foo.ts');
    expect(out.files[0].content).toBe('export const x = 1;\n');
    expect(out.files[1].path).toBe('README.md');
    expect(out.files[2].error).toBe('not_found');

    const md = render(out);
    expect(md).toContain('### Parent file snapshots');
    expect(md).toContain('**src/foo.ts**');
    expect(md).toContain('export const x = 1;');
  });

  it('strips path traversal attempts (..)', async () => {
    const out = await resolveParentContext({
      parent_job_id: '999',
      inherit_context: { files: ['../../../etc/passwd'] }
    });
    // After stripping `..`, the path collapses to `etc/passwd` under parent
    // worktree, which won't exist — so we get a not_found, NOT a successful
    // read of /etc/passwd.
    expect(out.files[0].error).toBe('not_found');
    expect(out.files[0].path).not.toContain('..');
  });
});

describe('renderParentContextBlock', () => {
  it('returns null when given null', () => {
    expect(renderParentContextBlock(null)).toBeNull();
  });

  it('renders custom blobs verbatim', () => {
    const md = renderParentContextBlock({
      parent_job_id: 'p1',
      custom: { hint: 'rebase on main before pushing' }
    });
    expect(md).toContain('### Parent custom blobs');
    expect(md).toContain('**hint**');
    expect(md).toContain('rebase on main before pushing');
  });

  it('renders forward-compat placeholders for field_schema and conflict_diff', () => {
    const md = renderParentContextBlock({
      parent_job_id: 'p2',
      field_schema: { note: 'not yet wired' },
      conflict_diff: { note: 'DEVPA-226 placeholder', parent_pr_url: 'https://example/pr/1' }
    });
    expect(md).toContain('### Parent field schema');
    expect(md).toContain('not yet wired');
    expect(md).toContain('### Parent conflict diff');
    expect(md).toContain('Parent PR: https://example/pr/1');
  });
});
