// tests/worker/failure-classifier.test.js
//
// Engine contract §4.2 — pure classification functions. No DB, no BullMQ,
// no docker required; these tests run in every environment.
import { describe, it, expect } from 'vitest';
import {
  FAILURE_CLASSES,
  MAX_INFRA_RETRIES,
  MAX_ENVELOPE_FEEDBACK_RETRIES,
  classifyPreSpawnError,
  classifyThrown,
  classifyEnvelopeFailure,
  classifyTimeout,
  classifyBudgetExceeded,
  classifyEnvelopeStatus,
  decideInfraRetry,
  decideEnvelopeRetry,
  buildEnvelopeFeedback,
} from '../../src/worker/failure-classifier.js';

describe('failure-classifier', () => {
  describe('classifyPreSpawnError', () => {
    it('is always infra_failure', () => {
      const out = classifyPreSpawnError(new Error('worktree clone failed'));
      expect(out.failure_class).toBe(FAILURE_CLASSES.INFRA);
      expect(out.reason).toMatch(/worktree clone failed/);
    });

    it('accepts a plain string', () => {
      const out = classifyPreSpawnError('boom');
      expect(out.failure_class).toBe('infra_failure');
      expect(out.reason).toBe('boom');
    });

    it('truncates very long messages', () => {
      const out = classifyPreSpawnError('x'.repeat(1000));
      expect(out.reason.length).toBe(300);
    });
  });

  describe('classifyThrown', () => {
    it('classifies ENOTFOUND as infra when work has not started', () => {
      const out = classifyThrown(new Error('fetch failed: ENOTFOUND plane.devpanl.dev'), { workStarted: false });
      expect(out.failure_class).toBe(FAILURE_CLASSES.INFRA);
    });

    it('classifies worktree errors as infra', () => {
      const out = classifyThrown(new Error('worktree prepare failed: no space left'));
      expect(out.failure_class).toBe(FAILURE_CLASSES.INFRA);
    });

    it('classifies spawn ENOENT as infra', () => {
      const out = classifyThrown(new Error('spawn claude ENOENT'));
      expect(out.failure_class).toBe(FAILURE_CLASSES.INFRA);
    });

    it('classifies an unrecognized crash as agent_failure by default', () => {
      const out = classifyThrown(new Error('TypeError: cannot read property of undefined'));
      expect(out.failure_class).toBe(FAILURE_CLASSES.AGENT);
    });

    it('classifies an infra-shaped message as agent_failure once work has started', () => {
      // Same message, but the agent had already begun working — the
      // contract forbids re-running once work started, so this must NOT
      // be treated as a free-retry infra failure.
      const out = classifyThrown(new Error('ECONNRESET'), { workStarted: true });
      expect(out.failure_class).toBe(FAILURE_CLASSES.AGENT);
    });
  });

  describe('classifyEnvelopeFailure', () => {
    it('is always agent_failure with reason invalid_envelope', () => {
      const out = classifyEnvelopeFailure('missing field: status');
      expect(out.failure_class).toBe(FAILURE_CLASSES.AGENT);
      expect(out.reason).toBe('invalid_envelope');
      expect(out.detail).toMatch(/missing field/);
    });
  });

  describe('classifyTimeout', () => {
    it('classifies stall as agent_failure/stall', () => {
      expect(classifyTimeout('stall')).toEqual({ failure_class: 'agent_failure', reason: 'stall' });
    });

    it('classifies wall-clock as agent_failure/timeout', () => {
      expect(classifyTimeout('wall_clock')).toEqual({ failure_class: 'agent_failure', reason: 'timeout' });
    });
  });

  describe('classifyBudgetExceeded', () => {
    it('is agent_failure/budget', () => {
      expect(classifyBudgetExceeded()).toEqual({ failure_class: 'agent_failure', reason: 'budget' });
    });
  });

  describe('classifyEnvelopeStatus', () => {
    it('done is not a failure', () => {
      expect(classifyEnvelopeStatus('done')).toBeNull();
    });

    it('blocked is ambiguity', () => {
      expect(classifyEnvelopeStatus('blocked')).toEqual({ failure_class: 'ambiguity' });
    });

    it('failed is quality_failure', () => {
      expect(classifyEnvelopeStatus('failed')).toEqual({ failure_class: 'quality_failure' });
    });

    it('an unknown status falls back to agent_failure, never loops silently', () => {
      const out = classifyEnvelopeStatus('weird');
      expect(out.failure_class).toBe('agent_failure');
      expect(out.reason).toMatch(/unknown_status/);
    });
  });

  describe('decideInfraRetry', () => {
    it('allows retry while attemptsMade < MAX_INFRA_RETRIES', () => {
      expect(decideInfraRetry(0)).toEqual({ shouldRetry: true, retriesRemaining: MAX_INFRA_RETRIES });
      expect(decideInfraRetry(1)).toEqual({ shouldRetry: true, retriesRemaining: MAX_INFRA_RETRIES - 1 });
    });

    it('refuses retry once the bound is reached', () => {
      expect(decideInfraRetry(MAX_INFRA_RETRIES)).toEqual({ shouldRetry: false, retriesRemaining: 0 });
      expect(decideInfraRetry(MAX_INFRA_RETRIES + 5)).toEqual({ shouldRetry: false, retriesRemaining: 0 });
    });

    it('MAX_INFRA_RETRIES is 2 per the contract', () => {
      expect(MAX_INFRA_RETRIES).toBe(2);
    });
  });

  describe('decideEnvelopeRetry', () => {
    it('allows exactly one retry-with-feedback', () => {
      expect(decideEnvelopeRetry(0)).toEqual({ shouldRetry: true });
      expect(decideEnvelopeRetry(1)).toEqual({ shouldRetry: false });
      expect(decideEnvelopeRetry(2)).toEqual({ shouldRetry: false });
    });

    it('defaults envelopeRetriesUsed to 0', () => {
      expect(decideEnvelopeRetry()).toEqual({ shouldRetry: true });
    });

    it('MAX_ENVELOPE_FEEDBACK_RETRIES is 1 per the contract', () => {
      expect(MAX_ENVELOPE_FEEDBACK_RETRIES).toBe(1);
    });
  });

  describe('buildEnvelopeFeedback', () => {
    it('includes the exact validation error and the schema', () => {
      const out = buildEnvelopeFeedback('missing field: handoff');
      expect(out).toMatch(/missing field: handoff/);
      expect(out).toMatch(/"status":"done\|blocked\|failed"/);
      expect(out).toMatch(/ONE retry/);
    });
  });
});
