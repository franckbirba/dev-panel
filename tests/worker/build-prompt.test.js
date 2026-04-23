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
