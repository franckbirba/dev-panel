// tests/worker/build-prompt.test.js
//
// Regression tests for the data.task legacy shape (telegram→shelly dispatches).
// Agents kept blocking with "empty payload" because buildPrompt only read
// data.work_item.{title,description} and ignored data.task.{title,description}.
// Jobs 42, 44, 113, 114, 115 all failed for this reason.
import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../../src/worker/prompt-builder.js';

describe('buildPrompt — legacy task shape', () => {
  it('includes task.title and task.description when work_item is absent', () => {
    const jobData = {
      job_id: 'test-1',
      agent: 'builder',
      task: {
        id: 'DEVPA-92',
        title: 'Add transcribe_audio MCP tool',
        description: 'Build a transcription MCP tool using Whisper.',
        branch: 'feat/devpa-92'
      }
    };

    const prompt = buildPrompt(jobData);

    expect(prompt).toContain('Add transcribe_audio MCP tool');
    expect(prompt).toContain('Build a transcription MCP tool using Whisper.');
  });

  it('prefers work_item over task when both are present', () => {
    const jobData = {
      job_id: 'test-2',
      agent: 'builder',
      task: { id: 'OLD-1', title: 'old title', description: 'old desc' },
      work_item: { title: 'new title', description: 'new desc' }
    };

    const prompt = buildPrompt(jobData);

    expect(prompt).toContain('new title');
    expect(prompt).toContain('new desc');
    expect(prompt).not.toContain('old title');
  });

  it('surfaces task.branch as context branch when context.branch is absent', () => {
    const jobData = {
      job_id: 'test-3',
      agent: 'builder',
      task: { id: 'DEVPA-92', title: 't', description: 'd', branch: 'feat/devpa-92' }
    };

    const prompt = buildPrompt(jobData);

    expect(prompt).toContain('feat/devpa-92');
  });
});

// DEVPA-228: parent_context blob (caller-controlled inheritance) must render
// as a `## Parent context` section in the prompt when present, and must be
// absent (no empty header) otherwise.
describe('buildPrompt — DEVPA-228 parent_context', () => {
  it('renders the parent context block when context.parent_context is present', () => {
    const jobData = {
      job_id: 'test-pc-1',
      agent: 'reviewer',
      work_item: { title: 'retry with another agent', description: 'd' },
      context: {
        parent_context: {
          parent_job_id: '999',
          parent_agent: 'builder',
          parent_workflow: 'work-item',
          parent_work_item_id: 'DEVPA-200',
          thread_context: {
            thread_id: 42,
            subject: 'work_item/DEVPA-200',
            message_count: 1,
            messages: [{ role: 'user', source: 'web', content: 'parent thread msg', at: '2026-05-17T10:00:00Z' }]
          }
        }
      }
    };
    const prompt = buildPrompt(jobData);
    expect(prompt).toContain('## Parent context');
    expect(prompt).toContain('**Parent job:** 999');
    expect(prompt).toContain('parent thread msg');
  });

  it('omits the parent context section when context.parent_context is absent', () => {
    const jobData = {
      job_id: 'test-pc-2',
      agent: 'builder',
      work_item: { title: 't', description: 'd' }
    };
    const prompt = buildPrompt(jobData);
    expect(prompt).not.toContain('## Parent context');
  });
});
