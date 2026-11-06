// src/worker/handlers/__tests__/capture-triage.test.js
// Unit tests for the capture triage handler

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { triagePendingCaptures, triageCapture } from '../capture-triage.js';

// Mock dependencies
vi.mock('../../server/db.js', () => ({
  getMasterDatabase: vi.fn()
}));

vi.mock('../../server/captures.js', () => ({
  getCapture: vi.fn(),
  updateCapture: vi.fn(),
  listCapturesAdmin: vi.fn()
}));

vi.mock('../../capabilities/plane-api.js', () => ({
  searchWorkItems: vi.fn()
}));

vi.mock('../../server/auto-decisions.js', () => ({
  recordAutoDecision: vi.fn()
}));

vi.mock('../../server/alerts.js', () => ({
  notifyJob: vi.fn()
}));

describe('capture-triage', () => {
  beforeEach(() => {
    // Reset mocks before each test
    vi.clearAllMocks();
  });

  describe('triagePendingCaptures', () => {
    it('should handle individual capture triage when capture_id is provided', async () => {
      const jobData = { capture_id: 'test-capture-id' };
      const mockResult = { status: 'promoted' };
      
      vi.mock('../capture-triage.js', () => ({
        triageCapture: vi.fn().mockResolvedValue(mockResult)
      }));

      const result = await triagePendingCaptures(jobData);
      
      expect(result).toEqual({
        status: 'completed',
        capture_id: 'test-capture-id',
        result: mockResult
      });
    });

    it('should process pending captures in batch mode', async () => {
      const jobData = {};
      const mockCaptures = [
        { id: 'capture-1' },
        { id: 'capture-2' }
      ];
      
      const { listCapturesAdmin } = await import('../../server/captures.js');
      listCapturesAdmin.mockReturnValue(mockCaptures);
      
      const mockTriageResult = { status: 'promoted' };
      vi.mock('../capture-triage.js', () => ({
        triageCapture: vi.fn().mockResolvedValue(mockTriageResult)
      }));

      const result = await triagePendingCaptures(jobData);
      
      expect(result.processed).toBe(2);
    });
  });

  describe('triageCapture', () => {
    it('should return error for non-existent capture', async () => {
      const { getCapture } = await import('../../server/captures.js');
      getCapture.mockReturnValue(null);

      const result = await triageCapture('non-existent-id');
      
      expect(result.status).toBe('error');
      expect(result.reason).toBe('not_found');
    });

    it('should skip already processed captures', async () => {
      const { getCapture } = await import('../../server/captures.js');
      getCapture.mockReturnValue({ id: 'test-id', status: 'promoted' });

      const result = await triageCapture('test-id');
      
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('already_processed');
    });

    it('should drop captures with content too short', async () => {
      const { getCapture } = await import('../../server/captures.js');
      getCapture.mockReturnValue({ 
        id: 'test-id', 
        status: 'new',
        content: 'hi'
      });

      const result = await triageCapture('test-id');
      
      expect(result.status).toBe('dropped');
      expect(result.reason).toBe('content_too_short');
    });
  });
});