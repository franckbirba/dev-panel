import { describe, it, beforeEach, afterEach } from 'vitest';
import { formatActivityMessage, sendActivityNotification } from '../../src/worker/activity-feed.js';
import { notifyJob } from '../../src/server/alerts.js';

// Mock the notifyJob function
vi.mock('../../src/server/alerts.js', () => ({
  notifyJob: vi.fn()
}));

describe('Activity Feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('formatActivityMessage', () => {
    it('should format workflow started message', () => {
      const message = formatActivityMessage('workflow.started', {
        work_item_id: 'WI-123',
        title: 'Implement new feature'
      });
      
      expect(message).toBe('▶️ Démarrage du workflow "Implement new feature" (#WI-123)');
    });

    it('should format PR opened message', () => {
      const message = formatActivityMessage('pr.opened', {
        title: 'Fix login bug',
        pr_url: 'https://github.com/org/repo/pull/456'
      });
      
      expect(message).toBe('📝 PR ouverte: Fix login bug (https://github.com/org/repo/pull/456)');
    });

    it('should format PR merged message', () => {
      const message = formatActivityMessage('pr.merged', {
        title: 'Add user authentication',
        pr_url: 'https://github.com/org/repo/pull/789'
      });
      
      expect(message).toBe('✅ PR mergée: Add user authentication (https://github.com/org/repo/pull/789)');
    });

    it('should format workflow blocked message', () => {
      const message = formatActivityMessage('workflow.blocked', {
        work_item_id: 'WI-234',
        title: 'Update documentation',
        reason: 'Missing dependencies'
      });
      
      expect(message).toBe('🚫 Workflow bloqué: "Update documentation" (#WI-234) - Missing dependencies');
    });

    it('should format replan message', () => {
      const message = formatActivityMessage('workflow.replan', {
        work_item_id: 'WI-345',
        title: 'Refactor API endpoints'
      });
      
      expect(message).toBe('🔄 Replan du workflow: "Refactor API endpoints" (#WI-345)');
    });

    it('should format instance reaped message', () => {
      const message = formatActivityMessage('instance.reaped', {
        work_item_id: 'WI-456',
        title: 'Optimize database queries',
        reason: 'Timeout after 24h'
      });
      
      expect(message).toBe('💀 Instance réapée: "Optimize database queries" (#WI-456) - Timeout after 24h');
    });

    it('should format budget threshold message', () => {
      const message = formatActivityMessage('budget.threshold', {
        work_item_id: 'WI-567',
        title: 'Large refactoring task',
        percent: 80
      });
      
      expect(message).toBe('⚠️ Seuil budget atteint: 80% pour "Large refactoring task" (#WI-567)');
    });

    it('should return null for unknown event types', () => {
      const message = formatActivityMessage('unknown.event', {});
      expect(message).toBeNull();
    });

    it('should return null when ACTIVITY_FEED_ENABLED is false', () => {
      // Temporarily set the environment variable
      const originalValue = process.env.ACTIVITY_FEED_ENABLED;
      process.env.ACTIVITY_FEED_ENABLED = 'false';
      
      const message = formatActivityMessage('workflow.started', {
        work_item_id: 'WI-123',
        title: 'Test'
      });
      
      // Restore the original value
      process.env.ACTIVITY_FEED_ENABLED = originalValue;
      
      expect(message).toBeNull();
    });
  });

  describe('sendActivityNotification', () => {
    it('should call notifyJob with formatted message', async () => {
      await sendActivityNotification('workflow.started', {
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

    it('should not call notifyJob for unknown event types', async () => {
      await sendActivityNotification('unknown.event', {});
      expect(notifyJob).not.toHaveBeenCalled();
    });

    it('should not call notifyJob when ACTIVITY_FEED_ENABLED is false', async () => {
      // Temporarily set the environment variable
      const originalValue = process.env.ACTIVITY_FEED_ENABLED;
      process.env.ACTIVITY_FEED_ENABLED = 'false';
      
      await sendActivityNotification('workflow.started', {
        work_item_id: 'WI-123',
        title: 'Test'
      });
      
      // Restore the original value
      process.env.ACTIVITY_FEED_ENABLED = originalValue;
      
      expect(notifyJob).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      notifyJob.mockRejectedValueOnce(new Error('Network error'));
      
      // Should not throw
      await expect(sendActivityNotification('workflow.started', {
        work_item_id: 'WI-123',
        title: 'Implement new feature'
      })).resolves.not.toThrow();
    });
  });
});