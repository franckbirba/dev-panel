// tests/server/job-inbox.test.js
// Coverage for the HITL inbox primitive: agent writes a question, human
// replies, agent reads back. Idempotency on duplicate callback_query
// retries. Cancellation orphan-handling. Lost-update protection on the
// consumed_at IS NULL predicate.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { startPg, stopPg, truncateOrchestration } from '../_helpers/pg.js';

const hasDocker = spawnSync('docker', ['version'], { stdio: 'ignore' }).status === 0;
const d = hasDocker ? describe : describe.skip;

d('job-inbox', () => {
  let inbox;

  beforeAll(async () => {
    await startPg();
    inbox = await import('../../src/server/job-inbox.js');
  }, 60000);

  afterAll(async () => {
    await stopPg();
  });

  beforeEach(() => truncateOrchestration());

  it('postQuestion writes an agent_question row at seq=1', async () => {
    const row = await inbox.postQuestion({
      job_id: 'job-1',
      kind: 'clarification',
      content: { prompt: 'which library?', options: ['A', 'B'] },
    });
    expect(row.seq).toBe(1);
    expect(row.role).toBe('agent_question');
    expect(row.kind).toBe('clarification');
    expect(row.consumed_at).toBeNull();
  });

  it('postQuestion increments seq per job', async () => {
    await inbox.postQuestion({ job_id: 'j', kind: 'clarification', content: { prompt: 'q1' } });
    const r2 = await inbox.postQuestion({ job_id: 'j', kind: 'clarification', content: { prompt: 'q2' } });
    expect(r2.seq).toBe(2);
  });

  it('postReply consumes the latest unconsumed question and returns it', async () => {
    await inbox.postQuestion({ job_id: 'j', kind: 'clarification', content: { prompt: 'q' } });
    const result = await inbox.postReply({ job_id: 'j', answer: 'use lib A' });
    expect(result.consumed_question_seq).toBe(1);
    expect(result.reply_seq).toBe(2);
  });

  it('postReply is idempotent on the same callback_query.id', async () => {
    await inbox.postQuestion({ job_id: 'j', kind: 'tool_approval', content: { tool: 'Bash' } });
    const r1 = await inbox.postReply({ job_id: 'j', answer: 'allow', callback_query_id: 'cb-42' });
    const r2 = await inbox.postReply({ job_id: 'j', answer: 'allow', callback_query_id: 'cb-42' });
    expect(r1.reply_seq).toBe(2);
    expect(r2.duplicate).toBe(true);
    // No second human_reply row should have landed.
    const all = await inbox.listForJob('j');
    expect(all.filter(r => r.role === 'human_reply')).toHaveLength(1);
  });

  it('postReply rejects when no unconsumed question exists', async () => {
    await expect(
      inbox.postReply({ job_id: 'orphan', answer: 'whatever' })
    ).rejects.toThrow(/no pending question/);
  });

  it('postReply rejects a second tap after consumption (race protection)', async () => {
    await inbox.postQuestion({ job_id: 'j', kind: 'clarification', content: { prompt: 'q' } });
    await inbox.postReply({ job_id: 'j', answer: 'first' });
    await expect(
      inbox.postReply({ job_id: 'j', answer: 'second' })
    ).rejects.toThrow(/no pending question/);
  });

  it('readNextReply returns null when nothing has arrived', async () => {
    await inbox.postQuestion({ job_id: 'j', kind: 'clarification', content: { prompt: 'q' } });
    const reply = await inbox.readNextReply({ job_id: 'j', after_seq: 1 });
    expect(reply).toBeNull();
  });

  it('readNextReply returns the human_reply once written', async () => {
    await inbox.postQuestion({ job_id: 'j', kind: 'clarification', content: { prompt: 'q' } });
    await inbox.postReply({ job_id: 'j', answer: 'go' });
    const reply = await inbox.readNextReply({ job_id: 'j', after_seq: 1 });
    expect(reply.role).toBe('human_reply');
    expect(reply.content.answer).toBe('go');
    expect(reply.seq).toBe(2);
  });

  it('cancelPending marks unconsumed rows with role=cancelled', async () => {
    await inbox.postQuestion({ job_id: 'j', kind: 'clarification', content: { prompt: 'q' } });
    const result = await inbox.cancelPending({ job_id: 'j' });
    expect(result.cancelled_count).toBe(1);
    const all = await inbox.listForJob('j');
    expect(all[0].role).toBe('cancelled');
    expect(all[0].consumed_at).not.toBeNull();
  });

  it('cancelPending is a no-op when nothing is pending', async () => {
    const result = await inbox.cancelPending({ job_id: 'nothing' });
    expect(result.cancelled_count).toBe(0);
  });
});
