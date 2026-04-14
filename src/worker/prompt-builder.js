// src/worker/prompt-builder.js
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

/**
 * Build the full prompt for claude -p from agent SOUL + skills + task
 * @param {Object} jobData - Job data from BullMQ
 * @returns {string} Assembled prompt
 */
export function buildPrompt(jobData) {
  const { agent, task, skills = [] } = jobData;

  const sections = [];

  // 1. Agent SOUL
  const soulPath = join(PROJECT_ROOT, '.agents', agent, 'SOUL.md');
  if (existsSync(soulPath)) {
    sections.push(readFileSync(soulPath, 'utf8'));
  } else {
    sections.push(`You are the ${agent} agent. Follow project conventions.`);
  }

  // 2. Skills
  if (skills.length > 0) {
    const skillContents = skills
      .map(skill => {
        const skillPath = join(PROJECT_ROOT, '.claude', 'skills', `${skill}.md`);
        if (existsSync(skillPath)) {
          return readFileSync(skillPath, 'utf8');
        }
        return null;
      })
      .filter(Boolean);

    if (skillContents.length > 0) {
      sections.push('## Skills\n\n' + skillContents.join('\n\n---\n\n'));
    }
  }

  // 3. Task
  sections.push([
    '## Task',
    '',
    `**ID:** ${task.id}`,
    `**Title:** ${task.title}`,
    task.description ? `**Description:** ${task.description}` : '',
    task.branch ? `**Branch:** ${task.branch}` : '',
    task.builder_output ? `**Builder Output:** ${JSON.stringify(task.builder_output)}` : ''
  ].filter(Boolean).join('\n'));

  // 4. Rules
  sections.push([
    '## Rules',
    '',
    `- Working directory: ${PROJECT_ROOT}`,
    task.branch ? `- Work on branch: ${task.branch}` : '- Work on a new branch named after the task ID',
    '- Never use git add -A or git add . — always add files explicitly',
    '- When done, output a JSON summary on the LAST line of your response:',
    '  ```json',
    '  {"files_created": [], "files_modified": [], "tests_passed": true, "summary": "..."}',
    '  ```'
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

  return { ok: false, error: 'no json object found in output' };
}
