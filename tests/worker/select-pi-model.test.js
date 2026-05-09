// tests/worker/select-pi-model.test.js
//
// Phase 2 of the harness migration. Verifies the pi model-routing helper
// honors precedence: FORCE_PI_MODEL > DRIVER_<AGENT>_PI_MODEL > tier table > null.
import { describe, it, expect } from 'vitest';
import { selectPiModel } from '../../src/worker/select-pi-model.js';

describe('selectPiModel', () => {
  it('routes cheap-tier roles to deepinfra/Qwen3-Coder-480B by default', () => {
    expect(selectPiModel('builder', {})).toEqual({
      provider: 'deepinfra',
      model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct'
    });
    expect(selectPiModel('designer', {})).toEqual({
      provider: 'deepinfra',
      model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct'
    });
    expect(selectPiModel('pm', {})).toEqual({
      provider: 'deepinfra',
      model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct'
    });
    expect(selectPiModel('merge-coordinator', {})).toEqual({
      provider: 'deepinfra',
      model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct'
    });
  });

  it('routes hard-tier roles to anthropic/claude-opus-4-7 by default', () => {
    expect(selectPiModel('reviewer', {})).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7'
    });
    expect(selectPiModel('architect', {})).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7'
    });
  });

  it('returns null for unknown roles', () => {
    expect(selectPiModel('unknown', {})).toBeNull();
    expect(selectPiModel(undefined, {})).toBeNull();
    expect(selectPiModel(null, {})).toBeNull();
  });

  it('FORCE_PI_MODEL overrides every role', () => {
    const env = { FORCE_PI_MODEL: 'anthropic/claude-haiku-4-5-20251001' };
    expect(selectPiModel('builder', env)).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001'
    });
    expect(selectPiModel('reviewer', env)).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001'
    });
  });

  it('DRIVER_<AGENT>_PI_MODEL pins one role without affecting others', () => {
    const env = { DRIVER_BUILDER_PI_MODEL: 'anthropic/claude-opus-4-7' };
    expect(selectPiModel('builder', env)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7'
    });
    expect(selectPiModel('designer', env)).toEqual({
      provider: 'deepinfra',
      model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct'
    });
  });

  it('DRIVER_<AGENT>_PI_MODEL handles hyphenated role names', () => {
    const env = { DRIVER_MERGE_COORDINATOR_PI_MODEL: 'anthropic/claude-opus-4-7' };
    expect(selectPiModel('merge-coordinator', env)).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-7'
    });
  });

  it('FORCE_PI_MODEL beats DRIVER_<AGENT>_PI_MODEL', () => {
    const env = {
      FORCE_PI_MODEL: 'deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct',
      DRIVER_BUILDER_PI_MODEL: 'anthropic/claude-opus-4-7'
    };
    expect(selectPiModel('builder', env)).toEqual({
      provider: 'deepinfra',
      model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct'
    });
  });

  it('preserves slashes in model ids when provider prefix is a known slug', () => {
    // Qwen/Qwen3-... has a slash in the model id; first slash separates
    // provider from model, rest stays as-is.
    expect(selectPiModel('builder', { FORCE_PI_MODEL: 'deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct' }))
      .toEqual({ provider: 'deepinfra', model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct' });
  });

  it('falls back to deepinfra when no provider prefix', () => {
    expect(selectPiModel('builder', { FORCE_PI_MODEL: 'Qwen/Qwen3-Coder-480B-A35B-Instruct' }))
      .toEqual({ provider: 'deepinfra', model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct' });
  });
});
