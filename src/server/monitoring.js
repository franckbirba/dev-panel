// ============================================================================
// MONITORING & HEALTH CHECKS
// ============================================================================

import fs from 'fs';
import { getProjectDatabase } from './db.js';

/**
 * Comprehensive health check with deep diagnostics
 * @param {string} storagePath - Path to storage directory
 * @returns {Object} Health status with component-level details
 */
export function getHealthStatus(storagePath = './storage') {
  const checks = {
    timestamp: new Date().toISOString(),
    status: 'healthy',
    components: {}
  };

  // 1. Database health
  try {
    const masterDbPath = `${storagePath}/projects.db`;
    const masterExists = fs.existsSync(masterDbPath);

    checks.components.database = {
      status: masterExists ? 'up' : 'down',
      master_db: masterExists,
      error: masterExists ? null : 'Master database not found'
    };

    if (!masterExists) {
      checks.status = 'degraded';
    }
  } catch (error) {
    checks.components.database = {
      status: 'down',
      error: error.message
    };
    checks.status = 'degraded';
  }

  // 2. GitHub connectivity (optional)
  checks.components.github = {
    status: process.env.GITHUB_TOKEN ? 'configured' : 'not_configured',
    token_set: !!process.env.GITHUB_TOKEN
  };

  // 3. Filesystem health
  try {
    const stats = fs.statSync(storagePath);
    checks.components.storage = {
      status: 'up',
      path: storagePath,
      writable: true
    };
  } catch (error) {
    checks.components.storage = {
      status: 'down',
      path: storagePath,
      error: error.message
    };
    checks.status = 'down';
  }

  // 4. Memory usage
  const memUsage = process.memoryUsage();
  checks.components.memory = {
    status: 'up',
    rss_mb: Math.round(memUsage.rss / 1024 / 1024),
    heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024)
  };

  // 5. Uptime
  checks.components.process = {
    status: 'up',
    uptime_seconds: Math.floor(process.uptime()),
    node_version: process.version,
    pid: process.pid
  };

  return checks;
}

/**
 * Project-specific health check
 * @param {string} storagePath - Path to storage directory
 * @param {string} projectId - Project ID
 * @returns {Object} Project health status
 */
export function getProjectHealth(storagePath, projectId) {
  const health = {
    project_id: projectId,
    timestamp: new Date().toISOString(),
    status: 'healthy',
    checks: {}
  };

  try {
    const db = getProjectDatabase(storagePath, projectId);

    // Check database integrity
    const integrityCheck = db.prepare('PRAGMA integrity_check').get();
    health.checks.database_integrity = {
      status: integrityCheck.integrity_check === 'ok' ? 'pass' : 'fail',
      result: integrityCheck.integrity_check
    };

    // Check ticket counts
    const ticketCount = db.prepare('SELECT COUNT(*) as count FROM tickets').get();
    health.checks.tickets = {
      status: 'pass',
      total_count: ticketCount.count
    };

    // Check for orphaned screenshots
    const orphanedScreenshots = db.prepare(`
      SELECT COUNT(*) as count FROM tickets
      WHERE screenshot IS NOT NULL
      AND LENGTH(screenshot) = 0
    `).get();

    health.checks.screenshots = {
      status: orphanedScreenshots.count === 0 ? 'pass' : 'warning',
      orphaned_count: orphanedScreenshots.count
    };

  } catch (error) {
    health.status = 'unhealthy';
    health.error = error.message;
  }

  return health;
}

/**
 * Get detailed metrics for monitoring systems
 * @param {string} storagePath - Path to storage directory
 * @returns {Object} Prometheus-compatible metrics
 */
export function getMetrics(storagePath = './storage') {
  const metrics = {
    timestamp: new Date().toISOString(),
    process: {
      uptime_seconds: Math.floor(process.uptime()),
      memory_rss_bytes: process.memoryUsage().rss,
      memory_heap_used_bytes: process.memoryUsage().heapUsed,
      cpu_user_seconds: process.cpuUsage().user / 1000000,
      cpu_system_seconds: process.cpuUsage().system / 1000000
    },
    runtime: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch
    }
  };

  return metrics;
}

/**
 * Check if a service is reachable
 * @param {string} url - Service URL
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<Object>} Service status
 */
export async function checkServiceHealth(url, timeout = 5000) {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    return {
      url,
      status: response.ok ? 'up' : 'degraded',
      http_status: response.status,
      response_time_ms: Date.now() - start,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      url,
      status: 'down',
      error: error.message,
      response_time_ms: Date.now() - start,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Get alert conditions based on health status
 * @param {Object} health - Health status object
 * @returns {Array} Array of alerts
 */
export function getAlerts(health) {
  const alerts = [];

  if (health.status === 'down') {
    alerts.push({
      severity: 'critical',
      message: 'System is down',
      component: 'system',
      timestamp: health.timestamp
    });
  }

  if (health.status === 'degraded') {
    alerts.push({
      severity: 'warning',
      message: 'System is degraded',
      component: 'system',
      timestamp: health.timestamp
    });
  }

  // Component-specific alerts
  for (const [component, status] of Object.entries(health.components || {})) {
    if (status.status === 'down') {
      alerts.push({
        severity: 'critical',
        message: `Component ${component} is down`,
        component,
        error: status.error,
        timestamp: health.timestamp
      });
    }
  }

  // Memory alerts
  if (health.components?.memory?.heap_used_mb > 500) {
    alerts.push({
      severity: 'warning',
      message: 'High memory usage detected',
      component: 'memory',
      heap_used_mb: health.components.memory.heap_used_mb,
      timestamp: health.timestamp
    });
  }

  return alerts;
}
