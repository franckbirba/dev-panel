// src/worker/parent-context.js
//
// DEVPA-228: resolve `inherit_context` against a parent BullMQ job and assemble
// a single `parent_context` blob that the prompt builder renders verbatim. The
// caller (enqueue_job / plane_dispatch_work_item) decides what to pull; the
// worker never widens jobData beyond the declared keys.
//
// Sources today (others can be added without breaking the schema):
//   - thread_context: parent's thread_subject + last N messages from `threads`
//   - files:          fs snapshot of the named paths under parent's project_root
//   - custom:         caller-supplied free-form keys, passed through
//   - field_schema:   parent's last tool_use of a plane_list_* tool (best-effort)
//   - conflict_diff:  forward-compat placeholder — real pr_merge_conflict tool
//                     ships in DEVPA-226. Until then we record the request so
//                     it surfaces in the parent context block.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { getQueue, QUEUES } from '../server/bullmq.js';
import { getOrCreateThread, listMessages } from '../server/threads.js';

const DEFAULT_THREAD_TAIL = 10;
const MAX_FILE_BYTES = 64 * 1024; // 64 KB per file is plenty for a snapshot
const MAX_THREAD_MESSAGES = 50;

/**
 * Pull selected slices of a parent job's context into a renderable blob.
 *
 * @param {object} args
 * @param {string} args.parent_job_id          BullMQ job id of the parent.
 * @param {object} args.inherit_context        Selector object — all fields optional.
 * @returns {Promise<object|null>}             `null` when inherit_context is empty
 *                                             OR parent can't be resolved.
 */
export async function resolveParentContext({ parent_job_id, inherit_context }) {
  if (!parent_job_id || !inherit_context || typeof inherit_context !== 'object') {
    return null;
  }
  const wantsAnything =
    inherit_context.thread_context ||
    inherit_context.conflict_diff ||
    inherit_context.field_schema ||
    (Array.isArray(inherit_context.files) && inherit_context.files.length > 0) ||
    (inherit_context.custom && Object.keys(inherit_context.custom).length > 0);
  if (!wantsAnything) return null;

  const parentJobData = await loadParentJobData(parent_job_id);
  if (!parentJobData) {
    return {
      parent_job_id,
      error: `parent job ${parent_job_id} not found in BullMQ`,
      requested: redactRequest(inherit_context),
    };
  }

  const out = {
    parent_job_id,
    parent_work_item_id: parentJobData.plane?.work_item_id || null,
    parent_agent: parentJobData.agent || null,
    parent_workflow: parentJobData.workflow || null,
  };

  if (inherit_context.thread_context) {
    out.thread_context = collectThreadContext(parentJobData);
  }
  if (Array.isArray(inherit_context.files) && inherit_context.files.length) {
    out.files = collectFiles(parentJobData, inherit_context.files);
  }
  if (inherit_context.custom && typeof inherit_context.custom === 'object') {
    out.custom = sanitizeCustom(inherit_context.custom);
  }
  if (inherit_context.field_schema) {
    out.field_schema = {
      note: 'field_schema requested; harvest from parent agent_job_events is best-effort and not yet wired',
    };
  }
  if (inherit_context.conflict_diff) {
    out.conflict_diff = {
      note: 'conflict_diff requested; pr_merge_conflict tool (DEVPA-226) not yet shipped',
      parent_pr_url: parentJobData.context?.pr_url || null,
    };
  }

  return out;
}

async function loadParentJobData(parent_job_id) {
  try {
    const queue = getQueue(QUEUES.agents);
    const job = await queue.getJob(String(parent_job_id));
    return job?.data || null;
  } catch {
    return null;
  }
}

function collectThreadContext(parentJobData) {
  // Parent's `thread_subject` is rarely set on jobData, so derive one from
  // the work_item_id when missing. listMessages(thread_id) is a synchronous
  // SQLite call wrapped by the threads module.
  const wiId = parentJobData.plane?.work_item_id;
  if (!wiId) return { error: 'parent had no plane.work_item_id; cannot locate thread' };
  try {
    const thread = getOrCreateThread('work_item', String(wiId));
    if (!thread?.id) return { thread_id: null, messages: [] };
    const all = listMessages(thread.id) || [];
    const tail = all.slice(-DEFAULT_THREAD_TAIL);
    return {
      thread_id: thread.id,
      subject: `work_item/${wiId}`,
      message_count: all.length,
      messages: tail.map(m => ({
        role: m.role,
        source: m.source,
        content: truncate(m.content, 4000),
        at: m.created_at,
      })).slice(0, MAX_THREAD_MESSAGES),
    };
  } catch (e) {
    return { error: `thread_context_failed: ${e.message}` };
  }
}

function collectFiles(parentJobData, files) {
  const root = parentJobData.context?.worktree_path
    || parentJobData.context?.project_root
    || process.env.PROJECT_ROOT
    || process.cwd();
  const out = [];
  for (const rel of files.slice(0, 20)) { // hard cap — prevent prompt blowup
    const safeRel = String(rel || '').replace(/\.\./g, '').replace(/^\/+/, '');
    if (!safeRel) continue;
    const abs = isAbsolute(rel) ? rel : join(root, safeRel);
    try {
      if (!existsSync(abs)) { out.push({ path: safeRel, error: 'not_found' }); continue; }
      const st = statSync(abs);
      if (!st.isFile()) { out.push({ path: safeRel, error: 'not_a_file' }); continue; }
      const buf = readFileSync(abs);
      if (buf.length > MAX_FILE_BYTES) {
        out.push({ path: safeRel, truncated: true, bytes: buf.length, content: buf.slice(0, MAX_FILE_BYTES).toString('utf8') });
      } else {
        out.push({ path: safeRel, bytes: buf.length, content: buf.toString('utf8') });
      }
    } catch (e) {
      out.push({ path: safeRel, error: e.message });
    }
  }
  return out;
}

function sanitizeCustom(custom) {
  const out = {};
  for (const [k, v] of Object.entries(custom)) {
    if (typeof k !== 'string' || !k) continue;
    out[String(k).slice(0, 80)] = typeof v === 'string' ? truncate(v, 8000) : String(v);
  }
  return out;
}

function redactRequest(inherit) {
  return {
    thread_context: !!inherit.thread_context,
    conflict_diff: !!inherit.conflict_diff,
    field_schema: !!inherit.field_schema,
    files: Array.isArray(inherit.files) ? inherit.files.length : 0,
    custom_keys: inherit.custom ? Object.keys(inherit.custom).length : 0,
  };
}

function truncate(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]` : s;
}

/**
 * Render the parent_context blob as a markdown block for the prompt.
 * Returns `null` when there's nothing to render, so callers can `.filter(Boolean)`.
 */
export function renderParentContextBlock(parentContext) {
  if (!parentContext || typeof parentContext !== 'object') return null;
  const lines = ['## Parent context', ''];
  lines.push(`**Parent job:** ${parentContext.parent_job_id}`);
  if (parentContext.parent_agent) lines.push(`**Parent agent:** ${parentContext.parent_agent}`);
  if (parentContext.parent_workflow) lines.push(`**Parent workflow:** ${parentContext.parent_workflow}`);
  if (parentContext.parent_work_item_id) lines.push(`**Parent work_item:** ${parentContext.parent_work_item_id}`);
  if (parentContext.error) {
    lines.push('', `> ${parentContext.error}`);
    return lines.join('\n');
  }

  if (parentContext.thread_context) {
    const tc = parentContext.thread_context;
    lines.push('', '### Parent thread tail');
    if (tc.error) {
      lines.push(`> ${tc.error}`);
    } else if (!tc.messages || !tc.messages.length) {
      lines.push('_(no messages yet on parent thread)_');
    } else {
      lines.push(`Subject: \`${tc.subject}\` · ${tc.message_count} total, showing last ${tc.messages.length}`);
      for (const m of tc.messages) {
        lines.push('', `**[${m.role}${m.source ? ` · ${m.source}` : ''}]** ${m.content}`);
      }
    }
  }

  if (parentContext.files && parentContext.files.length) {
    lines.push('', '### Parent file snapshots');
    for (const f of parentContext.files) {
      lines.push('', `**${f.path}**${f.truncated ? ' _(truncated)_' : ''}`);
      if (f.error) {
        lines.push(`> ${f.error}`);
      } else {
        lines.push('```');
        lines.push(f.content || '');
        lines.push('```');
      }
    }
  }

  if (parentContext.custom && Object.keys(parentContext.custom).length) {
    lines.push('', '### Parent custom blobs');
    for (const [k, v] of Object.entries(parentContext.custom)) {
      lines.push('', `**${k}**`);
      lines.push('```');
      lines.push(v);
      lines.push('```');
    }
  }

  if (parentContext.field_schema) {
    lines.push('', '### Parent field schema');
    lines.push(`> ${parentContext.field_schema.note}`);
  }

  if (parentContext.conflict_diff) {
    lines.push('', '### Parent conflict diff');
    lines.push(`> ${parentContext.conflict_diff.note}`);
    if (parentContext.conflict_diff.parent_pr_url) {
      lines.push(`Parent PR: ${parentContext.conflict_diff.parent_pr_url}`);
    }
  }

  return lines.join('\n');
}
