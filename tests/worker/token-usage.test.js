// tests/worker/token-usage.test.js
//
// Engine contract §6 — token budget extraction/accumulation. Pure functions,
// no I/O.
import { describe, it, expect } from 'vitest';
import {
  extractUsage,
  usageTotal,
  createUsageAccumulator,
  isBudgetExceeded,
} from '../../src/worker/token-usage.js';

describe('token-usage', () => {
  describe('extractUsage', () => {
    it('extracts usage from an assistant message event', () => {
      const event = {
        type: 'assistant',
        message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50 } },
      };
      expect(extractUsage(event)).toEqual({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
    });

    it('extracts a top-level usage field (result event shape)', () => {
      const event = { type: 'result', usage: { input_tokens: 10, output_tokens: 5 } };
      expect(extractUsage(event)).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
    });

    it('returns null when there is no usage field', () => {
      expect(extractUsage({ type: 'assistant', message: {} })).toBeNull();
      expect(extractUsage({})).toBeNull();
      expect(extractUsage(null)).toBeNull();
    });

    it('includes cache tokens when present', () => {
      const event = {
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 1000,
          },
        },
      };
      expect(extractUsage(event)).toEqual({
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 1000,
      });
    });

    it('coerces non-numeric fields to 0 defensively', () => {
      const event = { message: { usage: { input_tokens: 'bogus', output_tokens: null } } };
      expect(extractUsage(event)).toEqual({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      });
    });
  });

  describe('usageTotal', () => {
    it('sums input + output + cache_creation but NOT cache_read', () => {
      const usage = {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 999999,
      };
      expect(usageTotal(usage)).toBe(60);
    });

    it('returns 0 for null/undefined', () => {
      expect(usageTotal(null)).toBe(0);
      expect(usageTotal(undefined)).toBe(0);
    });
  });

  describe('createUsageAccumulator', () => {
    it('tracks the max cumulative total seen across events', () => {
      const acc = createUsageAccumulator();
      acc.record({ message: { usage: { input_tokens: 100, output_tokens: 10 } } }); // 110
      acc.record({ message: { usage: { input_tokens: 150, output_tokens: 20 } } }); // 170
      expect(acc.total()).toBe(170);
    });

    it('ignores events with no usage', () => {
      const acc = createUsageAccumulator();
      acc.record({ type: 'tool_use' });
      acc.record({ message: { usage: { input_tokens: 5, output_tokens: 5 } } });
      expect(acc.total()).toBe(10);
    });

    it('snapshot() returns the last-recorded usage plus total', () => {
      const acc = createUsageAccumulator();
      acc.record({ message: { usage: { input_tokens: 5, output_tokens: 5 } } });
      const snap = acc.snapshot();
      expect(snap.total).toBe(10);
      expect(snap.input_tokens).toBe(5);
    });

    it('a lower subsequent total does not overwrite the running max (out-of-order stream)', () => {
      const acc = createUsageAccumulator();
      acc.record({ message: { usage: { input_tokens: 500, output_tokens: 0 } } });
      acc.record({ message: { usage: { input_tokens: 10, output_tokens: 0 } } });
      expect(acc.total()).toBe(500);
    });
  });

  describe('isBudgetExceeded', () => {
    it('is false when at or under budget', () => {
      expect(isBudgetExceeded(200_000, 200_000)).toBe(false);
      expect(isBudgetExceeded(199_999, 200_000)).toBe(false);
    });

    it('is true once strictly over budget', () => {
      expect(isBudgetExceeded(200_001, 200_000)).toBe(true);
    });
  });
});
