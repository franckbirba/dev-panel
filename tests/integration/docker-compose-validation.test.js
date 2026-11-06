// tests/integration/docker-compose-validation.test.js
// Integration test for docker-compose validation in architect results

import { describe, it, expect } from 'vitest';
import { parseResult } from '../../src/worker/prompt-builder.js';

describe('docker-compose validation', () => {
  const BASE_RESULT = {
    status: 'done',
    summary: 'Architecture decision with docker-compose',
    artifacts: {
      files_created: [],
      files_modified: [],
      commits: ['abc123'],
      branch: 'feat/architect-decision-1',
      tests_passed: true,
      pr_url: null
    },
    handoff: { next_agent: 'builder', reason: 'ready for implementation' },
    memory_writes_count: 1,
    blockers: [],
    issues_found: []
  };

  it('should reject architect result without docker-compose files', () => {
    const result = {
      ...BASE_RESULT,
      context: { agent: 'architect' },
      artifacts: {
        ...BASE_RESULT.artifacts,
        files_created: ['docs/adr/0001-architectural-decision.md']
      }
    };
    
    const output = parseResult(`Some explanation\n${JSON.stringify(result)}`);
    expect(output.ok).toBe(false);
    expect(output.error).toContain('architect result must include docker-compose');
  });

  it('should accept architect result with docker-compose.yml', () => {
    const result = {
      ...BASE_RESULT,
      context: { agent: 'architect' },
      artifacts: {
        ...BASE_RESULT.artifacts,
        files_created: [
          'docs/adr/0001-architectural-decision.md',
          'docker-compose.yml'
        ]
      }
    };
    
    const output = parseResult(`Some explanation\n${JSON.stringify(result)}`);
    expect(output.ok).toBe(true);
  });

  it('should accept architect result with Dockerfile', () => {
    const result = {
      ...BASE_RESULT,
      context: { agent: 'architect' },
      artifacts: {
        ...BASE_RESULT.artifacts,
        files_created: [
          'docs/adr/0001-architectural-decision.md',
          'Dockerfile.frontend',
          'Dockerfile.backend'
        ]
      }
    };
    
    const output = parseResult(`Some explanation\n${JSON.stringify(result)}`);
    expect(output.ok).toBe(true);
  });
});