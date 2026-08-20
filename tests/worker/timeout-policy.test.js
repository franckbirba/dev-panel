// tests/worker/timeout-policy.test.js
//
// Engine contract §5 (stall + wall-clock timeouts) and §6 (budgets) — pure
// config functions, no DB/docker required.
import { describe, it, expect } from 'vitest';
import {
  agentTimeoutMs,
  stallTimeoutMs,
  budgetTokensFor,
  killGraceMs,
  computeLockDurationMs,
  checkLockDurationInvariant,
  DEFAULTS,
} from '../../src/worker/timeout-policy.js';

describe('timeout-policy', () => {
  describe('agentTimeoutMs', () => {
    it('builder defaults to 20 min', () => {
      expect(agentTimeoutMs('builder', {})).toBe(20 * 60 * 1000);
    });

    it('qa/reviewer/architect/merge-coordinator default to 15 min', () => {
      expect(agentTimeoutMs('qa', {})).toBe(15 * 60 * 1000);
      expect(agentTimeoutMs('reviewer', {})).toBe(15 * 60 * 1000);
      expect(agentTimeoutMs('architect', {})).toBe(15 * 60 * 1000);
      expect(agentTimeoutMs('merge-coordinator', {})).toBe(15 * 60 * 1000);
    });

    it('pm defaults to 10 min', () => {
      expect(agentTimeoutMs('pm', {})).toBe(10 * 60 * 1000);
    });

    it('unknown role falls back to the 15 min tier', () => {
      expect(agentTimeoutMs('designer', {})).toBe(15 * 60 * 1000);
    });

    it('AGENT_TIMEOUT_<ROLE>_MS overrides the default', () => {
      expect(agentTimeoutMs('builder', { AGENT_TIMEOUT_BUILDER_MS: '600000' })).toBe(600000);
    });

    it('dashes in role names become underscores in the env key', () => {
      expect(agentTimeoutMs('merge-coordinator', { AGENT_TIMEOUT_MERGE_COORDINATOR_MS: '111' })).toBe(111);
    });

    it('ignores a non-numeric override and falls back to default', () => {
      expect(agentTimeoutMs('builder', { AGENT_TIMEOUT_BUILDER_MS: 'nope' })).toBe(20 * 60 * 1000);
    });
  });

  describe('stallTimeoutMs', () => {
    it('defaults to 5 min', () => {
      expect(stallTimeoutMs({})).toBe(5 * 60 * 1000);
    });

    it('STALL_TIMEOUT_MS overrides the default', () => {
      expect(stallTimeoutMs({ STALL_TIMEOUT_MS: '60000' })).toBe(60000);
    });
  });

  describe('budgetTokensFor', () => {
    it('builder defaults to 200k', () => {
      expect(budgetTokensFor('builder', {})).toBe(200_000);
    });

    it('qa defaults to 150k', () => {
      expect(budgetTokensFor('qa', {})).toBe(150_000);
    });

    it('reviewer defaults to 100k', () => {
      expect(budgetTokensFor('reviewer', {})).toBe(100_000);
    });

    it('other roles default to 80k', () => {
      expect(budgetTokensFor('pm', {})).toBe(80_000);
      expect(budgetTokensFor('architect', {})).toBe(80_000);
    });

    it('BUDGET_TOKENS_<ROLE> overrides the default', () => {
      expect(budgetTokensFor('builder', { BUDGET_TOKENS_BUILDER: '5000' })).toBe(5000);
    });
  });

  describe('killGraceMs', () => {
    it('defaults to 30s', () => {
      expect(killGraceMs({})).toBe(30 * 1000);
    });

    it('AGENT_KILL_GRACE_MS overrides the default', () => {
      expect(killGraceMs({ AGENT_KILL_GRACE_MS: '5000' })).toBe(5000);
    });
  });

  describe('computeLockDurationMs / checkLockDurationInvariant', () => {
    it('is max(role timeouts) + 5 min with defaults', () => {
      // max default timeout is builder's 20 min
      expect(computeLockDurationMs({})).toBe(20 * 60 * 1000 + 5 * 60 * 1000);
    });

    it('the current index.js lockDuration (30 min) satisfies the invariant with default timeouts', () => {
      const { ok } = checkLockDurationInvariant(30 * 60 * 1000, {});
      expect(ok).toBe(true);
    });

    it('flags a violated invariant when lockDuration is too small', () => {
      const { ok, minRequiredMs } = checkLockDurationInvariant(10 * 60 * 1000, {});
      expect(ok).toBe(false);
      expect(minRequiredMs).toBe(25 * 60 * 1000);
    });

    it('reacts to a raised per-role timeout override', () => {
      const env = { AGENT_TIMEOUT_BUILDER_MS: String(60 * 60 * 1000) }; // 1h builder
      const min = computeLockDurationMs(env);
      expect(min).toBe(65 * 60 * 1000);
      expect(checkLockDurationInvariant(30 * 60 * 1000, env).ok).toBe(false);
      expect(checkLockDurationInvariant(70 * 60 * 1000, env).ok).toBe(true);
    });
  });

  describe('DEFAULTS export', () => {
    it('exposes the raw tables for introspection/tests elsewhere', () => {
      expect(DEFAULTS.AGENT_TIMEOUT_MS.builder).toBe(20 * 60 * 1000);
      expect(DEFAULTS.BUDGET_TOKENS.builder).toBe(200_000);
      expect(DEFAULTS.STALL_TIMEOUT_MS).toBe(5 * 60 * 1000);
    });
  });
});
