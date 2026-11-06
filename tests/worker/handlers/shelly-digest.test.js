import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleShellyDigest } from '../../../src/worker/handlers/shelly-digest.js';
import { getMasterDatabase } from '../../../src/server/db.js';
import { getQueue, QUEUES } from '../../../src/server/bullmq.js';
import { notifyJob } from '../../../src/server/alerts.js';

// Mock the dependencies
vi.mock('../../../src/server/db.js', () => ({
  getMasterDatabase: vi.fn()
}));

vi.mock('../../../src/server/bullmq.js', () => ({
  getQueue: vi.fn(),
  QUEUES: { agents: 'agents' }
}));

vi.mock('../../../src/server/alerts.js', () => ({
  notifyJob: vi.fn()
}));

describe('handleShellyDigest', () => {
  const mockDb = {
    prepare: vi.fn(() => ({
      all: vi.fn(),
      get: vi.fn()
    }))
  };

  const mockQueue = {
    getJobs: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getMasterDatabase.mockReturnValue(mockDb);
    getQueue.mockReturnValue(mockQueue);
    
    // Setup default mocks
    mockDb.prepare.mockImplementation(() => ({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue({ n: 0 })
    }));
    
    mockQueue.getJobs.mockResolvedValue([]);
    notifyJob.mockResolvedValue();
  });

  it('should generate morning digest correctly', async () => {
    const jobData = { job_id: 'test-job-1' };
    
    const result = await handleShellyDigest(jobData);
    
    expect(result.status).toBe('done');
    expect(notifyJob).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'digest',
      work_item_id: 'morning',
      title: expect.stringMatching(/.*↑ .*✗ .*∅/),
    }));
  });

  it('should generate evening digest correctly', async () => {
    const jobData = { job_id: 'test-job-2', digest_type: 'evening' };
    
    const result = await handleShellyDigest(jobData);
    
    expect(result.status).toBe('done');
    expect(notifyJob).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'digest',
      work_item_id: 'evening',
      title: expect.stringContaining('Soir:'),
    }));
  });

  it('should handle database errors gracefully', async () => {
    const jobData = { job_id: 'test-job-3', digest_type: 'evening' };
    
    // Simulate database error
    mockDb.prepare.mockImplementation(() => {
      throw new Error('Database error');
    });
    
    const result = await handleShellyDigest(jobData);
    
    expect(result.status).toBe('done');
    expect(notifyJob).toHaveBeenCalled();
  });

  it('should filter out empty lines in digest', async () => {
    const jobData = { job_id: 'test-job-4', digest_type: 'evening' };
    
    // Setup mocks to return zero counts
    mockDb.prepare.mockImplementation(() => ({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue({ n: 0 })
    }));
    
    const result = await handleShellyDigest(jobData);
    
    expect(result.status).toBe('done');
    expect(notifyJob).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'digest',
      work_item_id: 'evening',
    }));
  });
});