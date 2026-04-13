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

/**
 * Parse the JSON result from claude -p output
 * @param {string} output - Raw stdout from claude -p
 * @returns {Object} Parsed result or default
 */
export function parseResult(output) {
  // Look for JSON block at the end of output
  const jsonMatch = output.match(/```json\s*\n?([\s\S]*?)\n?```\s*$/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      // Fall through
    }
  }

  // Try last line as raw JSON
  const lines = output.trim().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      continue;
    }
  }

  return {
    files_created: [],
    files_modified: [],
    tests_passed: false,
    summary: output.slice(-500)
  };
}
