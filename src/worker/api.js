// src/worker/api.js
import express from 'express';
import { execSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { activeProcesses, worker, getMode } from './index.js';

const PORT = parseInt(process.env.WORKER_API_PORT || '3099');
const SHELLY_RESTART_LOG = '/home/deploy/logs/shelly-restarts.log';
const SHELLY_LOG = '/home/deploy/logs/shelly.log';

const app = express();
app.use(express.json());

// GET /health
app.get('/health', (req, res) => {
  res.json({
    status: 'running',
    uptime: process.uptime(),
    active_jobs: activeProcesses.size,
    concurrency: worker.opts.concurrency,
    mode: getMode().mode,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
    timestamp: new Date().toISOString()
  });
});

// GET /active
app.get('/active', (req, res) => {
  const jobs = [];
  for (const [jobId, { startedAt }] of activeProcesses) {
    jobs.push({
      job_id: jobId,
      started_at: new Date(startedAt).toISOString(),
      running_for: Math.round((Date.now() - startedAt) / 1000) + 's'
    });
  }
  res.json({ active: jobs });
});

// GET /shelly-health
// Lightweight liveness check for Shelly + the telegram channel plugin (bun).
// Designed to be hit by uptime-kuma — returns 200 only when both processes
// are alive. Body carries diagnostics for the dashboard pane.
app.get('/shelly-health', (req, res) => {
  const result = {
    healthy: false,
    claude_running: false,
    bun_running: false,
    bun_pid: null,
    claude_pid: null,
    restarts_24h: 0,
    last_restart: null,
    last_restart_reason: null,
    timestamp: new Date().toISOString()
  };

  try {
    const claudePids = execSync('pgrep -f "claude --channels"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n').filter(Boolean);
    if (claudePids.length) {
      result.claude_running = true;
      result.claude_pid = parseInt(claudePids[0], 10);
    }
  } catch { /* pgrep returns 1 when no match */ }

  try {
    const bunPids = execSync('pgrep -f "bun server.ts"', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split('\n').filter(Boolean);
    if (bunPids.length) {
      result.bun_running = true;
      result.bun_pid = parseInt(bunPids[0], 10);
    }
  } catch { /* no match */ }

  if (existsSync(SHELLY_RESTART_LOG)) {
    try {
      const lines = readFileSync(SHELLY_RESTART_LOG, 'utf8').trim().split('\n').filter(Boolean);
      const cutoffMs = Date.now() - 24 * 3600 * 1000;
      let count24 = 0;
      let last = null;
      for (const line of lines) {
        const m = line.match(/^(\S+)\s+restart\s+reason="([^"]+)"/);
        if (!m) continue;
        const t = Date.parse(m[1]);
        if (Number.isFinite(t) && t >= cutoffMs) count24++;
        last = { ts: m[1], reason: m[2] };
      }
      result.restarts_24h = count24;
      if (last) {
        result.last_restart = last.ts;
        result.last_restart_reason = last.reason;
      }
    } catch { /* unreadable, ignore */ }
  }

  result.healthy = result.claude_running && result.bun_running;
  res.status(result.healthy ? 200 : 503).json(result);
});

// GET /shelly-log?lines=200
// Tail of the shelly pane mirror. Cap at 1000 lines, default 200.
app.get('/shelly-log', (req, res) => {
  const lines = Math.min(1000, Math.max(1, parseInt(req.query.lines, 10) || 200));
  if (!existsSync(SHELLY_LOG)) return res.status(404).json({ error: 'shelly log not found' });
  try {
    const out = execSync(`tail -n ${lines} ${SHELLY_LOG}`, { encoding: 'utf8' });
    const size = statSync(SHELLY_LOG).size;
    res.type('text/plain').set('X-Log-Size-Bytes', String(size)).send(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /kill/:jobId
app.post('/kill/:jobId', (req, res) => {
  const { jobId } = req.params;
  const entry = activeProcesses.get(jobId);

  if (!entry) {
    return res.status(404).json({ error: `Job ${jobId} not active` });
  }

  entry.process.kill('SIGTERM');
  res.json({ killed: jobId });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Worker API] Listening on :${PORT}`);
});

export { app };
