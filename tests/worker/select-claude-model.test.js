// tests/worker/select-claude-model.test.js
//
// Phase 1 of the harness-vs-model canary. Verifies the model-routing helper
// honors precedence: FORCE_MODEL > DRIVER_<AGENT>_MODEL > tier table > null.
import { describe, it, expect } from 'vitest';
import { selectClaudeModel } from '../../src/worker/select-claude-model.js';

describe('selectClaudeModel', () => {
  it('routes cheap-tier roles to haiku-4.5 by default', () => {
    expect(selectClaudeModel('builder', {})).toBe('claude-haiku-4-5-20251001');
    expect(selectClaudeModel('designer', {})).toBe('claude-haiku-4-5-20251001');
    expect(selectClaudeModel('pm', {})).toBe('claude-haiku-4-5-20251001');
  });

  it('routes hard-tier roles (incl. merge-coordinator) to opus-4.7 by default', () => {
    expect(selectClaudeModel('reviewer', {})).toBe('claude-opus-4-7');
    expect(selectClaudeModel('qa', {})).toBe('claude-opus-4-7');
    expect(selectClaudeModel('architect', {})).toBe('claude-opus-4-7');
    expect(selectClaudeModel('deploy', {})).toBe('claude-opus-4-7');
    // merge-coordinator: promoted from cheap to hard 2026-05-12 after the
    // Zeno #78/#79 false-block incident — gh predicates are too subtle for haiku.
    expect(selectClaudeModel('merge-coordinator', {})).toBe('claude-opus-4-7');
  });

  it('returns null for unknown roles so the caller falls back to ambient default', () => {
    expect(selectClaudeModel('unknown', {})).toBeNull();
    expect(selectClaudeModel(undefined, {})).toBeNull();
  });

  it('FORCE_MODEL overrides the tier table for every role', () => {
    expect(selectClaudeModel('builder', { FORCE_MODEL: 'opus' })).toBe('claude-opus-4-7');
    expect(selectClaudeModel('reviewer', { FORCE_MODEL: 'haiku' })).toBe('claude-haiku-4-5-20251001');
    expect(selectClaudeModel('reviewer', { FORCE_MODEL: 'sonnet' })).toBe('claude-sonnet-4-6');
  });

  it('FORCE_MODEL accepts a raw model id when no alias matches', () => {
    expect(selectClaudeModel('builder', { FORCE_MODEL: 'claude-opus-4-7' }))
      .toBe('claude-opus-4-7');
  });

  it('DRIVER_<AGENT>_MODEL pins one role without affecting others', () => {
    const env = { DRIVER_BUILDER_MODEL: 'opus' };
    expect(selectClaudeModel('builder', env)).toBe('claude-opus-4-7');
    expect(selectClaudeModel('designer', env)).toBe('claude-haiku-4-5-20251001'); // still default
  });

  it('DRIVER_<AGENT>_MODEL handles hyphenated role names', () => {
    const env = { DRIVER_MERGE_COORDINATOR_MODEL: 'opus' };
    expect(selectClaudeModel('merge-coordinator', env)).toBe('claude-opus-4-7');
  });

  it('FORCE_MODEL beats DRIVER_<AGENT>_MODEL', () => {
    const env = { FORCE_MODEL: 'haiku', DRIVER_BUILDER_MODEL: 'opus' };
    expect(selectClaudeModel('builder', env)).toBe('claude-haiku-4-5-20251001');
  });
});
