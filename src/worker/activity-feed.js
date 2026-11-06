/**
 * Activity Feed Module - Sends Telegram notifications for workflow events
 * 
 * This module listens to workflow events and sends notifications to a Telegram chat.
 * Events covered:
 * - Workflow started
 * - PR opened
 * - PR merged
 * - Item blocked
 * - Replan
 * - Instance reaped
 * - Budget threshold reached (80%)
 */

import { notifyJob } from '../server/alerts.js';

// Check if activity feed is enabled
function isActivityFeedEnabled() {
  return process.env.ACTIVITY_FEED_ENABLED !== 'false';
}

/**
 * Format a French message for a workflow event
 * @param {string} eventType - Type of event
 * @param {object} data - Event data
 * @returns {string|null} Formatted message or null if event should not be notified
 */
export function formatActivityMessage(eventType, data) {
  if (!isActivityFeedEnabled()) {
    return null;
  }

  switch (eventType) {
    case 'workflow.started':
      return `▶️ Démarrage du workflow "${data.title}" (#${data.work_item_id})`;
      
    case 'pr.opened':
      return `📝 PR ouverte: ${data.title} (${data.pr_url})`;
      
    case 'pr.merged':
      return `✅ PR mergée: ${data.title} (${data.pr_url})`;
      
    case 'workflow.blocked':
      return `🚫 Workflow bloqué: "${data.title}" (#${data.work_item_id}) - ${data.reason}`;
      
    case 'workflow.replan':
      return `🔄 Replan du workflow: "${data.title}" (#${data.work_item_id})`;
      
    case 'instance.reaped':
      return `💀 Instance réapée: "${data.title}" (#${data.work_item_id}) - ${data.reason}`;
      
    case 'budget.threshold':
      return `⚠️ Seuil budget atteint: ${data.percent}% pour "${data.title}" (#${data.work_item_id})`;
      
    default:
      return null;
  }
}

/**
 * Send activity notification to Telegram
 * @param {string} eventType - Type of event
 * @param {object} data - Event data
 */
export async function sendActivityNotification(eventType, data) {
  if (!isActivityFeedEnabled()) {
    return;
  }

  const message = formatActivityMessage(eventType, data);
  if (!message) {
    return;
  }

  // Use notifyJob to send the message via Telegram
  try {
    await notifyJob({
      job_id: data.job_id || null,
      agent: 'activity-feed',
      work_item_id: data.work_item_id || null,
      title: data.title || 'Activité',
      status: 'info',
      extra: message
    });
  } catch (error) {
    console.error('[ActivityFeed] Failed to send notification:', error.message);
  }
}

/**
 * Handle workflow events and send notifications
 * @param {string} eventType - Type of event
 * @param {object} data - Event data
 */
export async function handleWorkflowEvent(eventType, data) {
  if (!isActivityFeedEnabled()) {
    return;
  }

  // Process different event types
  switch (eventType) {
    case 'workflow:changed':
      // Handle workflow state changes
      if (data.op === 'insert' && data.status === 'running') {
        await sendActivityNotification('workflow.started', {
          work_item_id: data.work_item_id,
          title: data.title || data.work_item_id || 'Nouveau workflow'
        });
      } else if (data.status === 'blocked') {
        await sendActivityNotification('workflow.blocked', {
          work_item_id: data.work_item_id,
          title: data.title || data.work_item_id || 'Workflow',
          reason: 'Bloqué'
        });
      } else if (data.status === 'exhausted') {
        await sendActivityNotification('instance.reaped', {
          work_item_id: data.work_item_id,
          title: data.title || data.work_item_id || 'Workflow',
          reason: 'Exhausted'
        });
      }
      break;
      
    case 'workflow.transitioned':
      // Handle workflow transitions
      if (data.reason === 'replan') {
        await sendActivityNotification('workflow.replan', {
          work_item_id: data.work_item_id,
          title: data.title || data.work_item_id || 'Workflow'
        });
      }
      break;
      
    case 'instance.reaped':
      await sendActivityNotification('instance.reaped', {
        work_item_id: data.work_item_id,
        title: data.title || data.work_item_id || 'Instance',
        reason: data.reason || 'Timeout'
      });
      break;
      
    case 'budget.threshold':
      await sendActivityNotification('budget.threshold', {
        work_item_id: data.work_item_id,
        title: data.title || data.work_item_id || 'Budget',
        percent: data.percent || 80
      });
      break;
      
    case 'pr.opened':
      await sendActivityNotification('pr.opened', {
        title: data.title || 'PR sans titre',
        pr_url: data.pr_url
      });
      break;
      
    case 'pr.merged':
      await sendActivityNotification('pr.merged', {
        title: data.title || 'PR sans titre',
        pr_url: data.pr_url
      });
      break;
  }
}

/**
 * Initialize activity feed - patches the broadcast function to intercept events
 */
export async function initActivityFeed() {
  if (!isActivityFeedEnabled()) {
    console.log('[ActivityFeed] Disabled by ACTIVITY_FEED_ENABLED=false');
    return;
  }

  // Import and patch the broadcast function
  const workflowInstances = await import('../server/workflow-instances.js');
  
  // Store original broadcast function
  const originalBroadcast = workflowInstances.broadcast;
  
  // Override broadcast to intercept events
  workflowInstances.broadcast = function(event, data) {
    // Call original broadcast function first
    originalBroadcast(event, data);
    
    // Handle our custom events
    handleWorkflowEvent(event, data).catch(err => {
      console.error('[ActivityFeed] Error handling event:', err.message);
    });
  };

  console.log('[ActivityFeed] Initialized and listening for events');
}

export default {
  formatActivityMessage,
  sendActivityNotification,
  initActivityFeed,
  handleWorkflowEvent
};