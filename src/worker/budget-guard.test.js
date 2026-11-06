// src/worker/budget-guard.test.js
import { describe, it, expect, vi } from 'vitest';
import {
  getDailyTokenBudget,
  getTokensConsumedToday,
  isBudgetExceeded,
  shouldWarnBudgetApproaching,
  logBudgetStatus
} from './budget-guard.js';

describe('budget-guard', () => {
  describe('getDailyTokenBudget', () => {
    it('should return default budget when not set', () => {
      const env = {};
      expect(getDailyTokenBudget(env)).toBe(5000000);
    });

    it('should return configured budget when set', () => {
      const env = { DAILY_TOKEN_BUDGET: '10000000' };
      expect(getDailyTokenBudget(env)).toBe(10000000);
    });

    it('should return null when budget is 0 (disabled)', () => {
      const env = { DAILY_TOKEN_BUDGET: '0' };
      expect(getDailyTokenBudget(env)).toBeNull();
    });

    it('should return default when invalid budget', () => {
      const env = { DAILY_TOKEN_BUDGET: 'invalid' };
      expect(getDailyTokenBudget(env)).toBe(5000000);
    });

    it('should return default when negative budget', () => {
      const env = { DAILY_TOKEN_BUDGET: '-1000' };
      expect(getDailyTokenBudget(env)).toBe(5000000);
    });
  });

  describe('isBudgetExceeded', () => {
    it('should return false when budget is null (unlimited)', () => {
      const result = isBudgetExceeded({ tokensConsumed: 10000000, budget: null });
      expect(result.exceeded).toBe(false);
      expect(result.percentage).toBe(0);
    });

    it('should return false when under budget', () => {
      const result = isBudgetExceeded({ tokensConsumed: 4000000, budget: 5000000 });
      expect(result.exceeded).toBe(false);
      expect(result.percentage).toBe(80);
    });

    it('should return true when at budget limit', () => {
      const result = isBudgetExceeded({ tokensConsumed: 5000000, budget: 5000000 });
      expect(result.exceeded).toBe(true);
      expect(result.percentage).toBe(100);
    });

    it('should return true when over budget', () => {
      const result = isBudgetExceeded({ tokensConsumed: 6000000, budget: 5000000 });
      expect(result.exceeded).toBe(true);
      expect(result.percentage).toBe(100); // capped at 100%
    });
  });

  describe('shouldWarnBudgetApproaching', () => {
    it('should return false when budget is null (unlimited)', () => {
      expect(shouldWarnBudgetApproaching({ tokensConsumed: 4000000, budget: null })).toBe(false);
    });

    it('should return false when well under 80%', () => {
      expect(shouldWarnBudgetApproaching({ tokensConsumed: 1000000, budget: 5000000 })).toBe(false);
    });

    it('should return true when at 80% threshold', () => {
      expect(shouldWarnBudgetApproaching({ tokensConsumed: 4000000, budget: 5000000 })).toBe(true);
    });

    it('should return true when between 80% and 100%', () => {
      expect(shouldWarnBudgetApproaching({ tokensConsumed: 4500000, budget: 5000000 })).toBe(true);
    });

    it('should return false when at 100%', () => {
      expect(shouldWarnBudgetApproaching({ tokensConsumed: 5000000, budget: 5000000 })).toBe(false);
    });

    it('should return false when over 100%', () => {
      expect(shouldWarnBudgetApproaching({ tokensConsumed: 6000000, budget: 5000000 })).toBe(false);
    });
  });

  describe('logBudgetStatus', () => {
    it('should log unlimited budget message', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      logBudgetStatus({ 
        tokensConsumed: 0, 
        budget: null, 
        exceeded: false, 
        percentage: 0 
      });
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[BudgetGuard] Budget tracking disabled (unlimited tokens)'
      );
      
      consoleLogSpy.mockRestore();
    });

    it('should log budget exceeded message', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      logBudgetStatus({ 
        tokensConsumed: 6000000, 
        budget: 5000000, 
        exceeded: true, 
        percentage: 100 
      });
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[BudgetGuard] Daily token budget exceeded: 6,000,000 / 5,000,000 tokens (100.0%) - backlog pulling suspended'
      );
      
      consoleLogSpy.mockRestore();
    });

    it('should log warning message when approaching limit', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      logBudgetStatus({ 
        tokensConsumed: 4500000, 
        budget: 5000000, 
        exceeded: false, 
        percentage: 90 
      });
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[BudgetGuard] Warning: Daily token budget approaching limit: 4,500,000 / 5,000,000 tokens (90.0%)'
      );
      
      consoleLogSpy.mockRestore();
    });

    it('should log normal status message', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      logBudgetStatus({ 
        tokensConsumed: 1000000, 
        budget: 5000000, 
        exceeded: false, 
        percentage: 20 
      });
      
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[BudgetGuard] Daily token consumption: 1,000,000 / 5,000,000 tokens (20.0%)'
      );
      
      consoleLogSpy.mockRestore();
    });
  });
});