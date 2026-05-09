// src/worker/prompt-builder.js
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

/**
 * Read the agent's SOUL.md text. Returns the file contents or a minimal
 * fallback. Exposed so the goose harness can write SOUL into a `.goosehints`
 * file at the worktree root instead of bundling it into recipe.instructions
 * — frees ~2k tokens/turn from the per-recipe prompt budget.
 * @param {string} agent - Agent role name
 * @returns {string}
 */
export function readSoul(agent) {
  const soulPath = join(PROJECT_ROOT, '.agents', agent, 'SOUL.md');
  if (existsSync(soulPath)) return readFileSync(soulPath, 'utf8');
  return `You are the ${agent} agent. Follow project conventions.`;
}

/**
 * Build the full prompt for claude -p from agent SOUL + skills + task
 * @param {Object} jobData - Job data from BullMQ
 * @param {Object} opts
 * @param {boolean} opts.skipSoul - Skip the SOUL section (used when the SOUL
 *   is delivered through a side channel like goose's .goosehints, so the
 *   recipe prompt doesn't double-ship it).
 * @returns {string} Assembled prompt
 */
export function buildPrompt(jobData, opts = {}) {
  const { skipSoul = false } = opts;
  const {
    job_id, agent, mode = 'autonomous',
    workflow = null, workflow_instance_id = null, workflow_revision = null,
    parent_workflow = null, parent_revision = null, failed_step = null,
    issues_found = [], blockers = [],
    plane = {}, work_item: work_itemRaw, task = {}, context: contextRaw = {},
    required_skills = [], allowed_mcp = [], memory_namespace = 'dev-panel'
  } = jobData;

  // Legacy dispatches (telegram→shelly) carry data.task.{id,title,description,branch}.
  // New dispatches carry data.work_item + data.context. Fall back to task.*
  // when work_item / context don't fill the field.
  const wi = work_itemRaw || {};
  const work_item = {
    ...wi,
    title: wi.title ?? task?.title,
    description: wi.description ?? task?.description
  };
  const context = {
    ...contextRaw,
    branch: contextRaw?.branch ?? task?.branch
  };
  // When the worker prepared a per-job worktree (DEVPA-144), surface its path
  // so the agent runs git/code there instead of PROJECT_ROOT. Falls back to
  // PROJECT_ROOT for non-coding agents and disabled-isolation runs.
  const workingDir = context.worktree_path || PROJECT_ROOT;

  const sections = [];

  if (workflow) {
    sections.push(
      `## Workflow context\n\n` +
      `- workflow: ${workflow}\n` +
      `- instance_id: ${workflow_instance_id}\n` +
      `- revision: ${workflow_revision}\n` +
      (parent_workflow ? `- parent_workflow: ${parent_workflow}\n` +
                         `- parent_revision: ${parent_revision}\n` +
                         `- failed_step: ${failed_step}\n` : '')
    );
  }

  // 1. Agent SOUL — skip when the harness delivers SOUL via a side channel
  // (e.g. goose's .goosehints, written to the worktree root before spawn).
  // Avoids double-shipping the SOUL on every per-job recipe.
  if (!skipSoul) {
    sections.push(readSoul(agent));
  }

  // 2. Required skills
  if (required_skills.length > 0) {
    const skillBlocks = required_skills.map(slug => {
      const path = slug.includes(':')
        ? join(PROJECT_ROOT, '.claude', 'skills', slug.replace(':', '-') + '.md')
        : join(PROJECT_ROOT, '.claude', 'skills', slug + '.md');
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    }).filter(Boolean);
    if (skillBlocks.length) {
      sections.push('## Skills (mandatory)\n\n' + skillBlocks.join('\n\n---\n\n'));
    }
  }

  // 3. Job context
  sections.push([
    '## Job',
    '',
    `**job_id:** ${job_id}`,
    `**mode:** ${mode}`,
    `**plane.module_id:** ${plane.module_id || '-'}`,
    `**plane.cycle_id:** ${plane.cycle_id || '-'}`,
    `**plane.work_item_id:** ${plane.work_item_id || '-'}`,
    '',
    '### Work item',
    `**Title:** ${work_item.title || ''}`,
    work_item.description ? `**Description:** ${work_item.description}` : '',
    work_item.acceptance_criteria ? `**Acceptance criteria:**\n${work_item.acceptance_criteria.map(c => `- ${c}`).join('\n')}` : '',
    work_item.priority ? `**Priority:** ${work_item.priority}` : '',
    '',
    '### Context',
    context.worktree_path ? `**Worktree:** ${context.worktree_path} (already checked out — work here, not in PROJECT_ROOT)` : '',
    context.branch ? `**Branch:** ${context.branch} (already created and checked out by the worker)` : '',
    context.github_issue_number ? `**GitHub issue:** #${context.github_issue_number}` : '',
    context.devpanel_ticket_id ? `**DevPanel ticket:** ${context.devpanel_ticket_id}` : '',
    context.parent_job_id ? `**Parent job:** ${context.parent_job_id}` : '',
    context.previous_agent_output ? `**Previous agent output:**\n\`\`\`json\n${JSON.stringify(context.previous_agent_output, null, 2)}\n\`\`\`` : ''
  ].filter(Boolean).join('\n'));

  // 4. Allowed MCP allowlist
  if (allowed_mcp.length) {
    sections.push('## Allowed MCP servers\n\n' + allowed_mcp.map(m => `- ${m}`).join('\n'));
  }

  // 5. Rules (output contract is non-negotiable)
  sections.push([
    '## Rules',
    '',
    `- Working directory: ${workingDir}`,
    `- Memory namespace: ${memory_namespace}`,
    '- Never use `git add -A` or `git add .` — add files explicitly.',
    '- You MUST call `memory_search` at the start (search the spec for how).',
    '- You MUST call `memory_write` for each non-obvious decision before finishing.',
    '- The LAST line of your response MUST be a single JSON object matching:',
    '',
    '```json',
    '{"status":"done|blocked|failed","summary":"...","artifacts":{"files_created":[],"files_modified":[],"commits":[],"branch":null,"tests_passed":false,"pr_url":null},"handoff":{"next_agent":null,"reason":""},"memory_writes_count":0,"blockers":[],"issues_found":[]}',
    '```',
    '',
    '- Any deviation from the JSON schema will fail the job.'
  ].join('\n'));

  return sections.join('\n\n---\n\n');
}

const REQUIRED_TOP = ['status', 'summary', 'artifacts', 'handoff', 'memory_writes_count', 'blockers', 'issues_found'];
const STATUS_ENUM = ['done', 'blocked', 'failed'];

function validate(obj) {
  for (const k of REQUIRED_TOP) {
    if (!(k in obj)) return `missing field: ${k}`;
  }
  if (!STATUS_ENUM.includes(obj.status)) return `invalid status: ${obj.status}`;
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) return 'summary must be non-empty string';
  if (typeof obj.artifacts !== 'object' || obj.artifacts === null) return 'artifacts must be object';
  if (typeof obj.handoff !== 'object' || obj.handoff === null) return 'handoff must be object';
  if (typeof obj.memory_writes_count !== 'number') return 'memory_writes_count must be number';
  if (!Array.isArray(obj.blockers)) return 'blockers must be array';
  if (!Array.isArray(obj.issues_found)) return 'issues_found must be array';
  return null;
}

/**
 * Parse the JSON result from claude -p output
 * @param {string} output - Raw stdout from claude -p
 * @returns {{ ok: true, data: Object } | { ok: false, error: string, raw?: Object }}
 */
export function parseResult(output) {
  const lines = output.trim().split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const err = validate(parsed);
        if (!err) return { ok: true, data: parsed };
        return { ok: false, error: err, raw: parsed };
      }
    } catch { /* try next */ }
  }

  const m = output.match(/```json\s*\n?([\s\S]*?)\n?```\s*$/);
  if (m) {
    try {
      const parsed = JSON.parse(m[1]);
      const err = validate(parsed);
      if (!err) return { ok: true, data: parsed };
      return { ok: false, error: err, raw: parsed };
    } catch (e) {
      return { ok: false, error: `invalid json in fenced block: ${e.message}` };
    }
  }

  const multilineCandidate = extractTrailingJsonObject(output);
  if (multilineCandidate) {
    try {
      const parsed = JSON.parse(multilineCandidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const err = validate(parsed);
        if (!err) return { ok: true, data: parsed };
        return { ok: false, error: err, raw: parsed };
      }
    } catch { /* fall through */ }
  }

  return { ok: false, error: 'no json object found in output' };
}

// Scan backwards from the last `}` to find the matching `{`,
// so a pretty-printed JSON block at the end of stdout parses.
// Ignores braces inside JSON strings (handles escaped quotes).
function extractTrailingJsonObject(output) {
  const end = output.lastIndexOf('}');
  if (end < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = end; i >= 0; i--) {
    const ch = output[i];
    if (inString) {
      if (ch === '"' && output[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return output.slice(i, end + 1);
    }
  }
  return null;
}
