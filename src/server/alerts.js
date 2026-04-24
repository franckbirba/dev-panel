// ============================================================================
// ALERT SYSTEM — Telegram notifications via Shelly
// ============================================================================

import { recordDeployEvent } from './deploy-events.js';

/**
 * Send alert to Telegram via Shelly
 * @param {Object} alert - Alert object
 * @param {string} alert.severity - 'critical', 'warning', 'info'
 * @param {string} alert.message - Alert message
 * @param {string} alert.component - Component name
 * @param {Object} alert.metadata - Additional metadata
 */
export async function sendTelegramAlert(alert) {
  const SHELLY_WEBHOOK = process.env.SHELLY_TELEGRAM_WEBHOOK;

  if (!SHELLY_WEBHOOK) {
    console.warn('[Alerts] SHELLY_TELEGRAM_WEBHOOK not configured, skipping alert');
    return;
  }

  const message = `*${alert.severity.toUpperCase()}*\n\n` +
    `*Component:* ${alert.component || 'system'}\n` +
    `*Message:* ${alert.message}\n` +
    `*Time:* ${alert.timestamp || new Date().toISOString()}\n` +
    (alert.metadata ? `\n\`\`\`json\n${JSON.stringify(alert.metadata, null, 2)}\n\`\`\`` : '');

  try {
    const response = await fetch(SHELLY_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: message,
        parse_mode: 'Markdown'
      })
    });

    if (!response.ok) {
      console.error('[Alerts] Failed to send Telegram alert:', response.statusText);
    } else {
      console.log(`[Alerts] Sent ${alert.severity} alert to Telegram`);
    }
  } catch (error) {
    console.error('[Alerts] Error sending Telegram alert:', error.message);
  }
}

/**
 * Alert manager that batches and deduplicates alerts
 */
export class AlertManager {
  constructor() {
    this.alertBuffer = [];
    this.sentAlerts = new Set();
    this.flushInterval = null;
  }

  /**
   * Start alert manager with auto-flush
   * @param {number} intervalMs - Flush interval in milliseconds
   */
  start(intervalMs = 60000) {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, intervalMs);

    console.log('[AlertManager] Started with flush interval:', intervalMs);
  }

  /**
   * Stop alert manager
   */
  stop() {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flush(); // Final flush
      console.log('[AlertManager] Stopped');
    }
  }

  /**
   * Add alert to buffer
   * @param {Object} alert - Alert object
   */
  add(alert) {
    const alertKey = `${alert.component}:${alert.severity}:${alert.message}`;

    // Deduplicate within 5 minutes
    const now = Date.now();
    const recentAlerts = Array.from(this.sentAlerts)
      .filter(([key, timestamp]) => now - timestamp < 5 * 60 * 1000);

    this.sentAlerts = new Set(recentAlerts);

    if (this.sentAlerts.has(alertKey)) {
      console.log(`[AlertManager] Skipping duplicate alert: ${alertKey}`);
      return;
    }

    this.alertBuffer.push(alert);
    this.sentAlerts.add([alertKey, now]);

    // Immediate flush for critical alerts
    if (alert.severity === 'critical') {
      this.flush();
    }
  }

  /**
   * Flush buffered alerts
   */
  async flush() {
    if (this.alertBuffer.length === 0) {
      return;
    }

    const alerts = [...this.alertBuffer];
    this.alertBuffer = [];

    console.log(`[AlertManager] Flushing ${alerts.length} alerts`);

    // Group by severity
    const critical = alerts.filter(a => a.severity === 'critical');
    const warnings = alerts.filter(a => a.severity === 'warning');
    const info = alerts.filter(a => a.severity === 'info');

    // Send critical alerts individually
    for (const alert of critical) {
      await sendTelegramAlert(alert);
    }

    // Batch warnings and info
    if (warnings.length > 0) {
      await sendTelegramAlert({
        severity: 'warning',
        component: 'multiple',
        message: `${warnings.length} warnings detected`,
        metadata: warnings,
        timestamp: new Date().toISOString()
      });
    }

    if (info.length > 0) {
      await sendTelegramAlert({
        severity: 'info',
        component: 'multiple',
        message: `${info.length} info alerts`,
        metadata: info,
        timestamp: new Date().toISOString()
      });
    }
  }
}

/**
 * Create default alert manager instance
 */
export const alertManager = new AlertManager();

// ============================================================================
// notifyJob — plain-ASCII per-job notification used by the worker automation matrix
// ============================================================================

const STATUS_WORD = {
  done: 'DONE',
  blocked: 'BLOCKED',
  failed: 'FAILED',
  approved: 'APPROVED',
  rejected: 'REJECTED'
};

let _debounceBuffer = [];
let _debounceTimer = null;

function _hasDestination() {
  return Boolean(
    process.env.SHELLY_TELEGRAM_WEBHOOK ||
    (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
  );
}

async function _sendText(text) {
  // Preferred: a Shelly webhook that accepts `{ text }` and forwards.
  const url = process.env.SHELLY_TELEGRAM_WEBHOOK;
  if (url) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }).catch(err => console.error('[Alerts] webhook send failed:', err.message));
  }
  // Fallback: direct Telegram Bot API.
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (token && chat) {
    return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text })
    }).catch(err => console.error('[Alerts] telegram API send failed:', err.message));
  }
}

function _flushDebounce() {
  const lines = _debounceBuffer.map(b => b.line).join('\n');
  const metadataId = _debounceBuffer.map(b => b.job_id).filter(Boolean).join(',');
  console.log('[Alerts] Flushing', _debounceBuffer.length, 'notification(s)');
  _debounceBuffer = [];
  _debounceTimer = null;
  if (!_hasDestination()) {
    console.warn('[Alerts] No destination configured');
    return;
  }
  const text = lines + (metadataId ? `\n<!-- job_ids:${metadataId} -->` : '');
  console.log('[Alerts] Sending:', text.substring(0, 100));
  return _sendText(text);
}

export async function notifyTicket({ id, type, title, project, created_by }) {
  if (!_hasDestination()) return;
  const kind = type === 'feature' ? 'feature' : 'bug';
  const who = created_by ? ` par ${String(created_by).slice(0, 40)}` : '';
  const cleanTitle = String(title || '').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const projectPart = project ? ` sur ${project}` : '';
  const text = `Nouveau ${kind}${projectPart}${who} — "${cleanTitle}" (ticket #${id})`;
  return _sendText(text);
}

export async function notifyJob({
  job_id = null, agent, work_item_id, title, status,
  duration_ms = null, extra = null, next_agent = null
}) {
  if (!_hasDestination()) {
    console.log('[Alerts] No destination, skipping notification');
    return;
  }

  const DEBOUNCE = parseInt(process.env.SHELLY_DEBOUNCE_MS ?? '5000', 10);
  const word = STATUS_WORD[status] || String(status).toUpperCase();
  // Cron jobs have no work_item_id and no title — never emit literal "undefined"
  // (that string was suspected of crashing Shelly's bun telegram plugin on inbound).
  const subject = work_item_id || job_id || agent;
  const titlePart = title ? ` "${String(title).replace(/[\r\n]+/g, ' ').slice(0, 80)}"` : '';
  const parts = [`[${agent}]`, `${subject}${titlePart}`, word];
  if (duration_ms != null) parts.push(`(${Math.round(duration_ms / 1000)}s${extra ? `, ${extra}` : ''})`);
  else if (extra) parts.push(`(${extra})`);
  parts.push(next_agent ? `  next: ${next_agent}` : `  next: -`);

  // Cap the whole line so a chatty agent summary can never poison a parser
  // downstream (Shelly's telegram plugin / claude inbound handler).
  let line = parts.join('  ').replace(/[\r\n]+/g, ' ').replace(/\s{3,}/g, '  ');
  if (line.length > 240) line = line.slice(0, 237) + '...';
  // Persist deploy + bootstrap events so the signals feed can surface them.
  // Best-effort — never throw out of notifyJob.
  if (agent === 'deploy' || agent === 'bootstrap') {
    try {
      const eventStatus = agent === 'bootstrap'
        ? (status === 'done' ? 'bootstrap_succeeded' : status === 'failed' ? 'bootstrap_failed' : null)
        : (status === 'done' ? 'succeeded' : status === 'failed' ? 'failed' : null);
      if (eventStatus && work_item_id) {
        const shaMatch = String(extra || '').match(/sha=([a-f0-9]+)/i);
        recordDeployEvent({
          project_id: work_item_id,
          status: eventStatus,
          sha: shaMatch ? shaMatch[1] : null,
          failed_reason: eventStatus === 'failed' ? String(extra || '').slice(0, 200) : null
        });
      }
    } catch (e) {
      console.error('[Alerts] recordDeployEvent failed:', e.message);
    }
  }

  console.log('[Alerts] Queuing:', line);
  _debounceBuffer.push({ job_id, line });
  if (!_debounceTimer) {
    console.log(`[Alerts] Starting ${DEBOUNCE}ms debounce timer`);
    _debounceTimer = setTimeout(_flushDebounce, DEBOUNCE);
  }
}
