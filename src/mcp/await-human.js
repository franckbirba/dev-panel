// src/mcp/await-human.js
// MCP tool implementation for `await_human` — the agent's HITL primitive.
// Spec: docs/superpowers/specs/2026-05-09-agent-interactivity-v2-design.md
//
// Flow:
//   1. Agent calls await_human({ kind, prompt, options?, timeout_s? }).
//   2. We POST /api/jobs/:job_id/inbox/question to register the question
//      (the API flips workflow_instance.status='awaiting_input').
//   3. We long-poll GET /api/jobs/:job_id/inbox?after_seq=<questionSeq>
//      until a human_reply or cancelled row arrives, or timeout.
//   4. On reply: return { answer, source } as a string to the agent.
//   5. On cancellation: throw — the workflow was cancelled while paused.
//   6. On timeout: return the configured default (autonomy=high) or throw
//      (autonomy=low handled by the worker via metadata).
//
// JOB_ID env var is injected by the worker at spawn time
// (src/worker/index.js:203). We read it once at tool registration so the
// agent process always knows which job it is.
//
// Hard constraints (preserves worker-as-commit-authority):
//   - Returns only `{ answer: string, source }`. No structured payloads the
//     agent could be tempted to act on.
//   - timeout_s clamped to 900 (= worker lockDuration / 2). Avoids fleet
//     deadlock at WORKER_CONCURRENCY=3.

import { z } from 'zod';

const TIMEOUT_MAX_S = 900;
const POLL_INTERVAL_MS = 5000;

export function awaitHumanSchema() {
  return {
    kind: z.enum(['clarification', 'tool_approval'])
      .default('clarification')
      .describe('clarification = free-form question; tool_approval = guard a tool call'),
    prompt: z.string().min(1)
      .describe('What you need the human to answer. One question per call. Be specific.'),
    options: z.array(z.string()).optional()
      .describe('For multiple-choice questions: 2-5 short options. Renders as inline keyboard buttons in Telegram.'),
    tool: z.string().optional()
      .describe('For kind=tool_approval: tool name being requested.'),
    args: z.record(z.string(), z.any()).optional()
      .describe('For kind=tool_approval: tool arguments under review.'),
    timeout_s: z.number().int().min(10).max(TIMEOUT_MAX_S).default(TIMEOUT_MAX_S)
      .describe(`Max seconds to wait. Clamped to ${TIMEOUT_MAX_S}s (= worker lock half-life).`),
    default_on_timeout: z.string().optional()
      .describe('Answer to use if no human replies before timeout (e.g. "deny" for tool_approval).'),
  };
}

export function makeAwaitHuman({
  apiBase,
  adminKey,
  jobId,
  workItemId = null,
  workflowName = null,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = POLL_INTERVAL_MS,
  now = () => Date.now(),
} = {}) {
  if (!apiBase) throw new Error('apiBase required');
  if (!adminKey) throw new Error('adminKey required');
  if (!jobId) throw new Error('jobId required');

  return async function awaitHuman({
    kind = 'clarification',
    prompt,
    options,
    tool,
    args,
    timeout_s = TIMEOUT_MAX_S,
    default_on_timeout,
  }) {
    const clampedTimeoutS = Math.min(timeout_s, TIMEOUT_MAX_S);
    const deadline = now() + clampedTimeoutS * 1000;

    const content = { prompt };
    if (options) content.options = options;
    if (kind === 'tool_approval') {
      content.tool = tool;
      content.args = args;
    }

    // 1. Register the question.
    const qResp = await fetchImpl(`${apiBase}/api/jobs/${encodeURIComponent(jobId)}/inbox/question`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey,
      },
      body: JSON.stringify({
        kind,
        content,
        work_item_id: workItemId,
        workflow_name: workflowName,
      }),
    });
    if (!qResp.ok) {
      const body = await qResp.text();
      throw new Error(`await_human: question post failed (${qResp.status}): ${body}`);
    }
    const { question } = await qResp.json();
    const after_seq = question.seq;

    // 2. Long-poll until reply, cancellation, or timeout.
    while (now() < deadline) {
      const pollResp = await fetchImpl(
        `${apiBase}/api/jobs/${encodeURIComponent(jobId)}/inbox?after_seq=${after_seq}`,
        { headers: { 'X-Admin-Key': adminKey } }
      );
      if (pollResp.status === 204) {
        await sleep(pollIntervalMs);
        continue;
      }
      if (!pollResp.ok) {
        const body = await pollResp.text();
        throw new Error(`await_human: poll failed (${pollResp.status}): ${body}`);
      }
      const { reply } = await pollResp.json();
      if (reply.role === 'cancelled') {
        throw new Error(`await_human: cancelled (job ${jobId} was cancelled while paused)`);
      }
      if (reply.role === 'human_reply') {
        return {
          answer: String(reply.content?.answer ?? ''),
          source: String(reply.content?.source ?? 'human'),
        };
      }
      await sleep(pollIntervalMs);
    }

    // 3. Timeout — fall back to default_on_timeout if provided, else throw.
    if (default_on_timeout != null) {
      return {
        answer: String(default_on_timeout),
        source: 'timeout-default',
      };
    }
    throw new Error(`await_human: timeout after ${clampedTimeoutS}s with no reply`);
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
