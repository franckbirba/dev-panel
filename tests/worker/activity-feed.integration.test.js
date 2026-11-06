import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import { handleWorkflowEvent } from '../../src/worker/activity-feed.js';
import { notifyJob } from '../../src/server/alerts.js';

// Mock the notifyJob function
vi.mock('../../src/server/alerts.js', () => ({
  notifyJob: vi.fn()
}));

describe('Activity Feed Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle workflow started event', async () => {
    await handleWorkflowEvent('workflow:changed', {
      op: 'insert',
      status: 'running',
      work_item_id: 'WI-123',
      title: 'Implement new feature'
    });

    expect(notifyJob).toHaveBeenCalledWith({
      job_id: null,
      agent: 'activity-feed',
      work_item_id: 'WI-123',
      title: 'Implement new feature',
      status: 'info',
      extra: '▶️ Démarrage du workflow "Implement new feature" (#WI-123)'
    });
  });

  it('should handle workflow blocked event', async () => {
    await handleWorkflowEvent('workflow:changed', {
      status: 'blocked',
      work_item_id: 'WI-234',
      title: 'Update documentation'
    });

    expect(notifyJob).toHaveBeenCalledWith({
      job_id: null,
      agent: 'activity-feed',
      work_item_id: 'WI-234',
      title: 'Update documentation',
      status: 'info',
      extra: '🚫 Workflow bloqué: "Update documentation" (#WI-234) - Bloqué'
    });
  });

  it('should handle replan event', async () => {
    await handleWorkflowEvent('workflow.transitioned', {
      reason: 'replan',
      work_item_id: 'WI-345',
      title: 'Refactor API endpoints'
    });

    expect(notifyJob).toHaveBeenCalledWith({
      job_id: null,
      agent: 'activity-feed',
      work_item_id: 'WI-345',
      title: 'Refactor API endpoints',
      status: 'info',
      extra: '🔄 Replan du workflow: "Refactor API endpoints" (#WI-345)'
    });
  });

  it('should handle instance reaped event', async () => {
    await handleWorkflowEvent('instance.reaped', {
      work_item_id: 'WI-456',
      title: 'Optimize database queries',
      reason: 'Timeout after 24h'
    });

    expect(notifyJob).toHaveBeenCalledWith({
      job_id: null,
      agent: 'activity-feed',
      work_item_id: 'WI-456',
      title: 'Optimize database queries',
      status: 'info',
      extra: '💀 Instance réapée: "Optimize database queries" (#WI-456) - Timeout after 24h'
    });
  });

  it('should handle budget threshold event', async () => {
    await handleWorkflowEvent('budget.threshold', {
      work_item_id: 'WI-567',
      title: 'Large refactoring task',
      percent: 80
    });

    expect(notifyJob).toHaveBeenCalledWith({
      job_id: null,
      agent: 'activity-feed',
      work_item_id: 'WI-567',
      title: 'Large refactoring task',
      status: 'info',
      extra: '⚠️ Seuil budget atteint: 80% pour "Large refactoring task" (#WI-567)'
    });
  });

  it('should not send notifications when ACTIVITY_FEED_ENABLED is false', async () => {
    // Temporarily set the environment variable
    const originalValue = process.env.ACTIVITY_FEED_ENABLED;
    process.env.ACTIVITY_FEED_ENABLED = 'false';
    
    await handleWorkflowEvent('workflow:changed', {
      op: 'insert',
      status: 'running',
      work_item_id: 'WI-123',
      title: 'Test'
    });
    
    // Restore the original value
    process.env.ACTIVITY_FEED_ENABLED = originalValue;
    
    expect(notifyJob).not.toHaveBeenCalled();
  });
});