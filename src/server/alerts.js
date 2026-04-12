// ============================================================================
// ALERT SYSTEM — Telegram notifications via Shelly
// ============================================================================

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

  const emoji = {
    critical: '🚨',
    warning: '⚠️',
    info: 'ℹ️'
  }[alert.severity] || '📢';

  const message = `${emoji} *${alert.severity.toUpperCase()}*\n\n` +
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
