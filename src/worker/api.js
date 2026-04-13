// src/worker/api.js
import express from 'express';
import { activeProcesses, worker, getMode } from './index.js';

const PORT = parseInt(process.env.WORKER_API_PORT || '3099');

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
