# Job Runner BullMQ — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the BullMQ job runner that transforms DevPanel into a H24 autonomous agent team controller.

**Architecture:** Single worker process on agents server consumes queue `agents` with concurrency 3, spawning `claude -p` per job. MCP DevPanel gets new tools for enqueue/cancel/mode. Pipeline chains builder → reviewer → merge. Mode autonomous/collaborative controls validation flow.

**Tech Stack:** Node.js, BullMQ 5, ioredis 5, Express (worker API), systemd

**Spec:** `docs/superpowers/specs/2026-04-13-job-runner-design.md`

**Plane Epic:** DEVPA-40

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/worker/index.js` | Worker process entry point — connects to Redis, consumes queue, spawns `claude -p`, registers crons |
| `src/worker/prompt-builder.js` | Reads SOUL + skills files, assembles prompt string for `claude -p` |
| `src/worker/api.js` | HTTP server :3099 on agents for kill/health/active endpoints |
| `src/worker/crons.js` | Registers repeatable jobs at worker startup |
| `.agents/builder/SOUL.md` | Builder agent personality and rules |
| `.agents/reviewer/SOUL.md` | Reviewer agent personality and rules |
| `.agents/pm/SOUL.md` | PM agent personality and rules |
| `.agents/designer/SOUL.md` | Designer agent personality and rules |
| `.agents/architect/SOUL.md` | Architect agent personality and rules |
| `.agents/qa/SOUL.md` | QA agent personality and rules |
| `infra/devpanel-worker.service` | Systemd unit file for worker |

### Modified files

| File | Changes |
|------|---------|
| `src/server/bullmq.js` | Add `agents` queue + `PRIORITY_MAP`, keep existing helpers |
| `src/mcp/server.js` | Add 5 tools: enqueue_job, list_jobs, cancel_job, set_mode, get_mode |
| `src/server/routes.js` | Add POST /api/jobs and POST /api/jobs/:id/kill |

---

## Task 1: Expose Redis on private IP (DEVPA-41)

**Files:**
- Modify: `infra/docker-compose.yml` on services server (77.42.46.87)

- [ ] **Step 1: SSH to services server and update docker-compose**

```bash
ssh -i ~/.ssh/hetzner-vps deploy@77.42.46.87
```

In the docker-compose file that defines `devpanel-redis`, add the port binding:

```yaml
devpanel-redis:
  image: redis:7-alpine
  container_name: devpanel-redis
  restart: unless-stopped
  command: redis-server --appendonly yes --maxmemory 256mb --maxmemory-policy noeviction
  ports:
    - "77.42.46.87:6379:6379"
  volumes:
    - redis-data:/data
  networks:
    - devpanel_net
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 10s
    timeout: 3s
    retries: 3
```

- [ ] **Step 2: Restart Redis container**

```bash
cd /home/deploy/dev-panel && docker compose up -d devpanel-redis
```

- [ ] **Step 3: Test connectivity from agents server**

```bash
ssh -i ~/.ssh/hetzner-vps root@62.238.0.167 "apt-get install -y redis-tools && redis-cli -h 77.42.46.87 ping"
```

Expected: `PONG`

- [ ] **Step 4: Commit**

No local commit needed — this is infra on the remote server.

---

## Task 2: Add agents queue to bullmq.js (DEVPA-50)

**Files:**
- Modify: `src/server/bullmq.js`

- [ ] **Step 1: Add AGENTS queue and PRIORITY_MAP to QUEUES config**

In `src/server/bullmq.js`, add after the existing `QUEUES` object (line 20-25):

```javascript
const QUEUES = {
  tickets: 'devpanel-tickets',
  github_sync: 'devpanel-github-sync',
  notifications: 'devpanel-notifications',
  agents: 'devpanel-agents',
  dlq: 'devpanel-dead-letter'
};

const PRIORITY_MAP = {
  p0: 1,   // urgent
  p1: 5,   // high
  p2: 10,  // normal
  p3: 20   // low
};
```

- [ ] **Step 2: Export PRIORITY_MAP**

Change the export at the bottom of `src/server/bullmq.js` from:

```javascript
export { QUEUES };
```

to:

```javascript
export { QUEUES, PRIORITY_MAP };
```

- [ ] **Step 3: Verify existing code still works**

```bash
node -e "import('./src/server/bullmq.js').then(m => { console.log('QUEUES:', m.QUEUES); console.log('PRIORITY_MAP:', m.PRIORITY_MAP); })"
```

Expected: Both objects logged with `agents` queue and priority map.

- [ ] **Step 4: Commit**

```bash
git add src/server/bullmq.js
git commit -m "feat(bullmq): add agents queue and priority map for job runner"
```

---

## Task 3: Create prompt-builder.js (DEVPA-42)

**Files:**
- Create: `src/worker/prompt-builder.js`

- [ ] **Step 1: Create the worker directory**

```bash
mkdir -p src/worker
```

- [ ] **Step 2: Write prompt-builder.js**

```javascript
// src/worker/prompt-builder.js
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

/**
 * Build the full prompt for claude -p from agent SOUL + skills + task
 * @param {Object} jobData - Job data from BullMQ
 * @returns {string} Assembled prompt
 */
export function buildPrompt(jobData) {
  const { agent, task, skills = [] } = jobData;

  const sections = [];

  // 1. Agent SOUL
  const soulPath = join(PROJECT_ROOT, '.agents', agent, 'SOUL.md');
  if (existsSync(soulPath)) {
    sections.push(readFileSync(soulPath, 'utf8'));
  } else {
    sections.push(`You are the ${agent} agent. Follow project conventions.`);
  }

  // 2. Skills
  if (skills.length > 0) {
    const skillContents = skills
      .map(skill => {
        const skillPath = join(PROJECT_ROOT, '.claude', 'skills', `${skill}.md`);
        if (existsSync(skillPath)) {
          return readFileSync(skillPath, 'utf8');
        }
        return null;
      })
      .filter(Boolean);

    if (skillContents.length > 0) {
      sections.push('## Skills\n\n' + skillContents.join('\n\n---\n\n'));
    }
  }

  // 3. Task
  sections.push([
    '## Task',
    '',
    `**ID:** ${task.id}`,
    `**Title:** ${task.title}`,
    task.description ? `**Description:** ${task.description}` : '',
    task.branch ? `**Branch:** ${task.branch}` : '',
    task.builder_output ? `**Builder Output:** ${JSON.stringify(task.builder_output)}` : ''
  ].filter(Boolean).join('\n'));

  // 4. Rules
  sections.push([
    '## Rules',
    '',
    `- Working directory: ${PROJECT_ROOT}`,
    task.branch ? `- Work on branch: ${task.branch}` : '- Work on a new branch named after the task ID',
    '- Never use git add -A or git add . — always add files explicitly',
    '- When done, output a JSON summary on the LAST line of your response:',
    '  ```json',
    '  {"files_created": [], "files_modified": [], "tests_passed": true, "summary": "..."}',
    '  ```'
  ].join('\n'));

  return sections.join('\n\n---\n\n');
}

/**
 * Parse the JSON result from claude -p output
 * @param {string} output - Raw stdout from claude -p
 * @returns {Object} Parsed result or default
 */
export function parseResult(output) {
  // Look for JSON block at the end of output
  const jsonMatch = output.match(/```json\s*\n?([\s\S]*?)\n?```\s*$/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[1]);
    } catch {
      // Fall through
    }
  }

  // Try last line as raw JSON
  const lines = output.trim().split('\n');
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      continue;
    }
  }

  return {
    files_created: [],
    files_modified: [],
    tests_passed: false,
    summary: output.slice(-500)
  };
}
```

- [ ] **Step 3: Test it runs without errors**

```bash
node -e "import('./src/worker/prompt-builder.js').then(m => console.log('OK:', typeof m.buildPrompt, typeof m.parseResult))"
```

Expected: `OK: function function`

- [ ] **Step 4: Commit**

```bash
git add src/worker/prompt-builder.js
git commit -m "feat(worker): add prompt builder for assembling SOUL + skills + task"
```

---

## Task 4: Create worker process (DEVPA-42)

**Files:**
- Create: `src/worker/index.js`

- [ ] **Step 1: Write the worker**

```javascript
// src/worker/index.js
import { Worker, QueueEvents } from 'bullmq';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildPrompt, parseResult } from './prompt-builder.js';
import { QUEUES, PRIORITY_MAP, getQueue } from '../server/bullmq.js';

const require = createRequire(import.meta.url);
const Redis = require('ioredis');

// Config
const REDIS_HOST = process.env.REDIS_HOST || '77.42.46.87';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '3');
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const MODE_FILE = process.env.MODE_FILE || join(process.env.HOME || '/home/deploy', '.shelly-mode.json');

const connection = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

// Active processes map: jobId -> { process, startedAt }
const activeProcesses = new Map();

/**
 * Read current Shelly mode
 */
function getMode() {
  try {
    if (existsSync(MODE_FILE)) {
      return JSON.parse(readFileSync(MODE_FILE, 'utf8'));
    }
  } catch { /* ignore */ }
  return { mode: 'collaborative', since: new Date().toISOString(), morning_review: [] };
}

/**
 * Append to morning review log
 */
function logMorningReview(entry) {
  const state = getMode();
  state.morning_review.push({
    ...entry,
    timestamp: new Date().toISOString()
  });
  writeFileSync(MODE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Spawn claude -p and return the output
 */
function spawnAgent(jobId, prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt, '--print', '--dangerously-skip-permissions'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: [
          join(process.env.HOME || '/home/deploy', '.bun/bin'),
          join(process.env.HOME || '/home/deploy', '.local/bin'),
          join(process.env.HOME || '/home/deploy', '.npm-global/bin'),
          '/usr/local/bin',
          '/usr/bin',
          '/bin'
        ].join(':')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    activeProcesses.set(jobId, { process: proc, startedAt: Date.now() });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      activeProcesses.delete(jobId);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`claude -p exited with code ${code}\nstderr: ${stderr.slice(-1000)}`));
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(jobId);
      reject(err);
    });
  });
}

// ============================================================================
// WORKER
// ============================================================================

const worker = new Worker(QUEUES.agents, async (job) => {
  const { agent, task, skills } = job.data;
  console.log(`[Worker] Starting job ${job.id} — ${agent}:${task.id} (priority: ${job.opts.priority})`);

  // Build prompt
  const prompt = buildPrompt(job.data);

  // Spawn agent
  const output = await spawnAgent(job.id, prompt);

  // Parse result
  const result = parseResult(output);
  result.agent = agent;
  result.task_id = task.id;
  result.raw_length = output.length;

  console.log(`[Worker] Job ${job.id} completed — ${result.summary?.slice(0, 100)}`);

  return result;

}, {
  connection,
  concurrency: CONCURRENCY,
  stalledInterval: 120000,  // 2 min stall check
  lockDuration: 1800000     // 30 min lock (long-running jobs)
});

// ============================================================================
// PIPELINE: builder -> reviewer -> merge
// ============================================================================

worker.on('completed', async (job, result) => {
  const { agent, task, source } = job.data;
  const mode = getMode();

  console.log(`[Pipeline] ${agent}:${task.id} completed (mode: ${mode.mode})`);

  // Log for morning review if autonomous
  if (mode.mode === 'autonomous') {
    logMorningReview({
      type: 'completed',
      job_id: job.id,
      agent,
      task_id: task.id,
      task_title: task.title,
      summary: result?.summary || 'No summary'
    });
  }

  // Chain: builder (tests passed) -> reviewer
  if (agent === 'builder' && result?.tests_passed && source !== 'pipeline') {
    const agentsQueue = getQueue(QUEUES.agents);
    await agentsQueue.add(`review:${task.id}`, {
      agent: 'reviewer',
      task: {
        ...task,
        builder_output: result
      },
      skills: ['agent-reviewer'],
      source: 'pipeline',
      requested_by: 'worker'
    }, {
      priority: PRIORITY_MAP.p1
    });
    console.log(`[Pipeline] Enqueued reviewer for ${task.id}`);
  }

  // Chain: reviewer approved (autonomous mode) -> log merge-ready
  if (agent === 'reviewer' && source === 'pipeline') {
    if (mode.mode === 'autonomous') {
      logMorningReview({
        type: 'merge_ready',
        task_id: task.id,
        task_title: task.title,
        branch: task.branch,
        review_result: result?.summary || 'Approved'
      });
      console.log(`[Pipeline] ${task.id} merge-ready (autonomous — logged for morning review)`);
    } else {
      console.log(`[Pipeline] ${task.id} review done — awaiting Franck validation (collaborative mode)`);
    }
  }
});

worker.on('failed', (job, err) => {
  const { agent, task } = job.data;
  const mode = getMode();

  console.error(`[Worker] Job ${job.id} failed — ${agent}:${task.id}: ${err.message}`);

  // If max attempts reached, log for morning review
  if (job.attemptsMade >= (job.opts.attempts || 3)) {
    if (mode.mode === 'autonomous') {
      logMorningReview({
        type: 'failed',
        job_id: job.id,
        agent,
        task_id: task.id,
        task_title: task.title,
        error: err.message
      });
    }
  }
});

worker.on('error', (err) => {
  console.error('[Worker] Error:', err);
});

// ============================================================================
// STARTUP
// ============================================================================

console.log(`[Worker] Starting on ${REDIS_HOST}:${REDIS_PORT} with concurrency ${CONCURRENCY}`);
console.log(`[Worker] Project root: ${PROJECT_ROOT}`);
console.log(`[Worker] Mode file: ${MODE_FILE}`);

// Export for api.js
export { activeProcesses, worker, getMode };
```

- [ ] **Step 2: Test it imports without errors**

```bash
node -e "import('./src/worker/index.js').then(() => console.log('Worker loaded')).catch(e => console.error(e.message))" 2>&1 | head -5
```

Expected: Either "Worker loaded" or a Redis connection error (acceptable — Redis isn't reachable from local).

- [ ] **Step 3: Commit**

```bash
git add src/worker/index.js
git commit -m "feat(worker): create BullMQ worker process with pipeline and mode support"
```

---

## Task 5: Create worker HTTP API (DEVPA-42)

**Files:**
- Create: `src/worker/api.js`

- [ ] **Step 1: Write the worker API**

```javascript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/worker/api.js
git commit -m "feat(worker): add HTTP API for kill/health/active endpoints"
```

---

## Task 6: Create crons registration (DEVPA-48)

**Files:**
- Create: `src/worker/crons.js`

- [ ] **Step 1: Write crons.js**

```javascript
// src/worker/crons.js
import { getQueue, QUEUES, PRIORITY_MAP } from '../server/bullmq.js';

const CRON_JOBS = [
  {
    name: 'pm:daily-sync',
    data: {
      agent: 'pm',
      task: { id: 'CRON-SYNC', title: 'Daily sync Plane → GitHub → DevPanel' },
      skills: ['shelly-sync'],
      source: 'cron',
      requested_by: 'cron'
    },
    repeat: { pattern: '0 7 * * *' },
    priority: PRIORITY_MAP.p2
  },
  {
    name: 'pm:sprint-plan',
    data: {
      agent: 'pm',
      task: { id: 'CRON-SPRINT', title: 'Weekly sprint planning' },
      skills: ['agent-pm'],
      source: 'cron',
      requested_by: 'cron'
    },
    repeat: { pattern: '0 8 * * 1' },
    priority: PRIORITY_MAP.p2
  }
];

/**
 * Register all repeatable jobs. BullMQ deduplicates automatically.
 */
export async function registerCrons() {
  const queue = getQueue(QUEUES.agents);

  for (const cron of CRON_JOBS) {
    await queue.add(cron.name, cron.data, {
      repeat: cron.repeat,
      priority: cron.priority
    });
    console.log(`[Crons] Registered ${cron.name} (${cron.repeat.pattern})`);
  }
}
```

- [ ] **Step 2: Import and call registerCrons in worker/index.js**

Add at the end of `src/worker/index.js`, before the final export:

```javascript
// Register crons
import { registerCrons } from './crons.js';
registerCrons().catch(err => console.error('[Crons] Registration failed:', err));
```

- [ ] **Step 3: Commit**

```bash
git add src/worker/crons.js src/worker/index.js
git commit -m "feat(worker): add cron job registration at startup"
```

---

## Task 7: Add MCP tools for jobs (DEVPA-43)

**Files:**
- Modify: `src/mcp/server.js`

- [ ] **Step 1: Add BullMQ imports at the top of src/mcp/server.js**

After the existing imports (line 1-17), add:

```javascript
import { Queue } from 'bullmq';
import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const requireMcp = createRequire(import.meta.url);
const Redis = requireMcp('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || '77.42.46.87';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const MODE_FILE = process.env.MODE_FILE || join(process.env.HOME || '/home/deploy', '.shelly-mode.json');
const WORKER_API = process.env.WORKER_API || 'http://localhost:3099';

const PRIORITY_MAP = { p0: 1, p1: 5, p2: 10, p3: 20 };

let agentsQueue = null;
function getAgentsQueue() {
  if (!agentsQueue) {
    agentsQueue = new Queue('devpanel-agents', {
      connection: new Redis({
        host: REDIS_HOST,
        port: REDIS_PORT,
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      })
    });
  }
  return agentsQueue;
}
```

- [ ] **Step 2: Add enqueue_job tool**

Add before the `// START` section:

```javascript
server.tool(
  'enqueue_job',
  'Enqueue a job for an agent in the BullMQ queue',
  {
    agent: z.enum(['builder', 'reviewer', 'pm', 'designer', 'architect', 'qa']).describe('Agent type'),
    task_id: z.string().describe('Task ID from Plane (e.g. DEVPA-42)'),
    task_title: z.string().describe('Task title'),
    task_description: z.string().default('').describe('Task description'),
    skills: z.array(z.string()).default([]).describe('Skill names to inject'),
    priority: z.enum(['p0', 'p1', 'p2', 'p3']).default('p2').describe('Job priority'),
    branch: z.string().optional().describe('Git branch name'),
    source: z.enum(['telegram', 'dashboard', 'cron']).default('telegram')
  },
  async ({ agent, task_id, task_title, task_description, skills, priority, branch, source }) => {
    try {
      const queue = getAgentsQueue();
      const job = await queue.add(`${agent}:${task_id}`, {
        agent,
        task: {
          id: task_id,
          title: task_title,
          description: task_description,
          branch: branch || `feat/${task_id.toLowerCase()}`
        },
        skills,
        priority,
        source,
        requested_by: 'shelly'
      }, {
        priority: PRIORITY_MAP[priority] || 10,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        timeout: 1800000
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            job_id: job.id,
            agent,
            task_id,
            priority,
            message: `Job enqueued: ${agent}:${task_id} (priority ${priority})`
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error enqueuing job: ${err.message}` }], isError: true };
    }
  }
);
```

- [ ] **Step 3: Add list_jobs tool**

```javascript
server.tool(
  'list_jobs',
  'List jobs in the agents queue by status',
  {
    status: z.enum(['waiting', 'active', 'completed', 'failed', 'delayed']).default('active'),
    limit: z.number().default(10)
  },
  async ({ status, limit }) => {
    try {
      const queue = getAgentsQueue();
      const jobs = await queue.getJobs([status], 0, limit - 1);

      const result = jobs.map(job => ({
        id: job.id,
        name: job.name,
        agent: job.data?.agent,
        task_id: job.data?.task?.id,
        priority: job.opts?.priority,
        attempts: job.attemptsMade,
        created: job.timestamp ? new Date(job.timestamp).toISOString() : null
      }));

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error listing jobs: ${err.message}` }], isError: true };
    }
  }
);
```

- [ ] **Step 4: Add cancel_job tool**

```javascript
server.tool(
  'cancel_job',
  'Cancel a waiting job or kill an active job',
  {
    job_id: z.string().describe('BullMQ job ID')
  },
  async ({ job_id }) => {
    try {
      const queue = getAgentsQueue();
      const job = await queue.getJob(job_id);

      if (!job) {
        return { content: [{ type: 'text', text: `Job ${job_id} not found` }], isError: true };
      }

      const state = await job.getState();

      if (state === 'active') {
        // Forward kill to worker API
        try {
          const resp = await fetch(`${WORKER_API}/kill/${job_id}`, { method: 'POST' });
          if (resp.ok) {
            return { content: [{ type: 'text', text: `Job ${job_id} kill signal sent` }] };
          }
          return { content: [{ type: 'text', text: `Worker API error: ${resp.status}` }], isError: true };
        } catch {
          return { content: [{ type: 'text', text: `Cannot reach worker API at ${WORKER_API}` }], isError: true };
        }
      }

      // Remove waiting/delayed job
      await job.remove();
      return { content: [{ type: 'text', text: `Job ${job_id} removed (was ${state})` }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error cancelling job: ${err.message}` }], isError: true };
    }
  }
);
```

- [ ] **Step 5: Add set_mode tool**

```javascript
server.tool(
  'set_mode',
  'Switch Shelly between autonomous and collaborative mode',
  {
    mode: z.enum(['autonomous', 'collaborative']).describe('Operating mode')
  },
  async ({ mode }) => {
    const state = {
      mode,
      since: new Date().toISOString(),
      morning_review: mode === 'collaborative' ? [] : (
        existsSync(MODE_FILE)
          ? JSON.parse(readFileSync(MODE_FILE, 'utf8')).morning_review || []
          : []
      )
    };
    writeFileSync(MODE_FILE, JSON.stringify(state, null, 2));
    return { content: [{ type: 'text', text: `Mode set to ${mode}` }] };
  }
);
```

- [ ] **Step 6: Add get_mode tool**

```javascript
server.tool(
  'get_mode',
  'Get current Shelly operating mode and morning review log',
  {},
  async () => {
    let state = { mode: 'collaborative', since: null, morning_review: [] };
    try {
      if (existsSync(MODE_FILE)) {
        state = JSON.parse(readFileSync(MODE_FILE, 'utf8'));
      }
    } catch { /* ignore */ }
    return { content: [{ type: 'text', text: JSON.stringify(state, null, 2) }] };
  }
);
```

- [ ] **Step 7: Test MCP server starts**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node src/mcp/server.js 2>&1 | head -5
```

Expected: JSON-RPC response with server capabilities.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/server.js
git commit -m "feat(mcp): add enqueue_job, list_jobs, cancel_job, set_mode, get_mode tools"
```

---

## Task 8: Add API endpoints for dashboard (DEVPA-44)

**Files:**
- Modify: `src/server/routes.js`

- [ ] **Step 1: Add import for QUEUES and PRIORITY_MAP**

At the top of `src/server/routes.js`, add after the existing imports:

```javascript
import { getQueue, QUEUES, PRIORITY_MAP } from './bullmq.js';
```

- [ ] **Step 2: Add POST /api/jobs endpoint**

Add before the SSE section in routes.js, inside the `createRoutes` function:

```javascript
  // ============================================================================
  // JOB ENQUEUE (Dashboard)
  // ============================================================================

  router.post('/api/jobs', authenticateAdmin, async (req, res) => {
    try {
      const { agent, task_id, task_title, task_description, skills, priority, branch, source } = req.body;

      if (!agent || !task_id || !task_title) {
        return res.status(400).json({ error: 'Required: agent, task_id, task_title' });
      }

      const queue = getQueue(QUEUES.agents);
      const job = await queue.add(`${agent}:${task_id}`, {
        agent,
        task: {
          id: task_id,
          title: task_title,
          description: task_description || '',
          branch: branch || `feat/${task_id.toLowerCase()}`
        },
        skills: skills || [],
        priority: priority || 'p2',
        source: source || 'dashboard',
        requested_by: 'dashboard'
      }, {
        priority: PRIORITY_MAP[priority] || PRIORITY_MAP.p2,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        timeout: 1800000
      });

      res.json({ job_id: job.id, agent, task_id, priority: priority || 'p2' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================================
  // JOB KILL (Dashboard -> Worker API proxy)
  // ============================================================================

  router.post('/api/jobs/:id/kill', authenticateAdmin, async (req, res) => {
    const workerApi = process.env.WORKER_API || 'http://62.238.0.167:3099';
    try {
      const resp = await fetch(`${workerApi}/kill/${req.params.id}`, { method: 'POST' });
      const data = await resp.json();
      res.status(resp.status).json(data);
    } catch (err) {
      res.status(502).json({ error: `Cannot reach worker: ${err.message}` });
    }
  });
```

- [ ] **Step 3: Commit**

```bash
git add src/server/routes.js
git commit -m "feat(api): add POST /api/jobs and POST /api/jobs/:id/kill endpoints"
```

---

## Task 9: Create SOUL files (DEVPA-45)

**Files:**
- Create: `.agents/builder/SOUL.md`
- Create: `.agents/reviewer/SOUL.md`
- Create: `.agents/pm/SOUL.md`
- Create: `.agents/designer/SOUL.md`
- Create: `.agents/architect/SOUL.md`
- Create: `.agents/qa/SOUL.md`

- [ ] **Step 1: Create directories**

```bash
mkdir -p .agents/{builder,reviewer,pm,designer,architect,qa}
```

- [ ] **Step 2: Write builder SOUL**

File: `.agents/builder/SOUL.md`

```markdown
# Builder Agent

You are the Builder. You write production code, tests, and deliver working features.

## Identity
- Role: Senior developer
- Tone: Concise, technical, focused
- Language: Follow the project's existing patterns

## Rules
1. Always create a feature branch: `feat/{task-id}-{short-description}`
2. Write tests BEFORE or alongside implementation
3. Run tests before committing — never commit broken code
4. Never use `git add -A` or `git add .` — add files explicitly
5. Commit messages follow conventional commits: `feat:`, `fix:`, `test:`, `refactor:`
6. Never merge to main — the Reviewer handles that
7. Keep changes minimal and focused on the task

## Process
1. Read the task description carefully
2. Create the feature branch
3. Implement the feature with tests
4. Run `npm test` and ensure all tests pass
5. Commit with a clear message linking to the task ID
6. Output the JSON summary

## What you DON'T do
- You don't review code (Reviewer does that)
- You don't merge branches
- You don't modify CI/CD pipelines
- You don't change project configuration without explicit request
```

- [ ] **Step 3: Write reviewer SOUL**

File: `.agents/reviewer/SOUL.md`

```markdown
# Reviewer Agent

You are the Reviewer. You review code from the Builder for quality, correctness, and convention adherence.

## Identity
- Role: Senior code reviewer
- Tone: Constructive, precise, fair
- Language: French for comments to Franck, English for code comments

## Rules
1. Always pull the branch and read the diff
2. Run tests — if they fail, reject immediately
3. Check: code quality, naming, no hardcoded secrets, no `git add -A`
4. Check: tests exist and are meaningful (not just smoke tests)
5. Check: conventional commit messages
6. If approved in autonomous mode: merge to main
7. If approved in collaborative mode: report to Shelly, wait for Franck

## Process
1. Checkout the branch from builder_output
2. Run `npm test`
3. Read the diff (`git diff main...HEAD`)
4. Evaluate against the task requirements
5. If OK: approve and merge (autonomous) or report (collaborative)
6. If KO: list specific issues in the summary

## Output
- `tests_passed`: boolean
- `approved`: boolean
- `issues`: array of strings (empty if approved)
- `summary`: short review summary
```

- [ ] **Step 4: Write PM SOUL**

File: `.agents/pm/SOUL.md`

```markdown
# PM Agent

You are the PM. You manage the backlog, write specs, prioritize work, and keep systems in sync.

## Identity
- Role: Product manager
- Tone: Structured, clear, action-oriented
- Language: French

## Rules
1. Source of truth for tasks: Plane
2. Always check existing items before creating new ones (no duplicates)
3. Every task needs: clear title, description, acceptance criteria, priority
4. Sync direction: Plane → GitHub Issues (not the reverse)
5. Daily sync checks all systems are consistent

## Process (daily sync)
1. List all Plane work items in current cycle
2. Check GitHub issues are in sync
3. Report discrepancies
4. Update statuses based on PR/branch state

## Process (sprint planning)
1. Review completed items from last sprint
2. Check backlog priorities
3. Propose next sprint items based on roadmap
4. Output structured plan
```

- [ ] **Step 5: Write designer SOUL**

File: `.agents/designer/SOUL.md`

```markdown
# Designer Agent

You are the Designer. You create wireframes, design tokens, and component specifications in Penpot.

## Identity
- Role: UI/UX designer
- Tone: Visual, precise about spacing/colors/typography
- Language: French

## Rules
1. Design system: Ink & Wire (project design system)
2. Always export design tokens as JSON
3. Component specs include: states, props, responsive breakpoints
4. Follow existing patterns in the design system
```

- [ ] **Step 6: Write architect SOUL**

File: `.agents/architect/SOUL.md`

```markdown
# Architect Agent

You are the Architect. You write Architecture Decision Records and review technical decisions.

## Identity
- Role: Technical architect
- Tone: Analytical, thorough
- Language: English for ADRs, French for discussions

## Rules
1. ADRs follow the format in docs/adr/
2. Every significant technical decision gets an ADR
3. Review architecture before complex features
4. Consider: scalability, maintainability, simplicity
```

- [ ] **Step 7: Write QA SOUL**

File: `.agents/qa/SOUL.md`

```markdown
# QA Agent

You are QA. You validate after PRs are merged — tests, build, edge cases.

## Identity
- Role: Quality assurance engineer
- Tone: Thorough, systematic
- Language: French for reports

## Rules
1. Run full test suite after merge
2. Run build to catch compilation errors
3. Check edge cases not covered by unit tests
4. Report findings in Plane work item
```

- [ ] **Step 8: Commit**

```bash
git add .agents/builder/SOUL.md .agents/reviewer/SOUL.md .agents/pm/SOUL.md .agents/designer/SOUL.md .agents/architect/SOUL.md .agents/qa/SOUL.md
git commit -m "feat(agents): create SOUL files for all 6 agents"
```

---

## Task 10: Create systemd service (DEVPA-49)

**Files:**
- Create: `infra/devpanel-worker.service`

- [ ] **Step 1: Write the systemd unit file**

File: `infra/devpanel-worker.service`

```ini
[Unit]
Description=DevPanel Agent Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/home/deploy/projects/dev-panel
ExecStart=/usr/bin/node src/worker/index.js
Restart=always
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

# Environment
Environment=NODE_ENV=production
Environment=REDIS_HOST=77.42.46.87
Environment=REDIS_PORT=6379
Environment=WORKER_CONCURRENCY=3
Environment=WORKER_API_PORT=3099
Environment=PROJECT_ROOT=/home/deploy/projects/dev-panel
Environment=PATH=/home/deploy/.bun/bin:/home/deploy/.local/bin:/home/deploy/.npm-global/bin:/usr/local/bin:/usr/bin:/bin

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=devpanel-worker

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Commit**

```bash
git add infra/devpanel-worker.service
git commit -m "feat(infra): add systemd service for worker on agents server"
```

- [ ] **Step 3: Deploy to agents server**

```bash
ssh -i ~/.ssh/hetzner-vps root@62.238.0.167 "cp /home/deploy/projects/dev-panel/infra/devpanel-worker.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable devpanel-worker && systemctl start devpanel-worker && systemctl status devpanel-worker"
```

Expected: Active (running).

---

## Task 11: Update MCP config for Shelly (DEVPA-43)

**Files:**
- Modify: `/home/deploy/.mcp.json` on agents server

- [ ] **Step 1: Update .mcp.json to include devpanel-mcp with Redis env**

```bash
ssh -i ~/.ssh/hetzner-vps root@62.238.0.167 "sudo -u deploy bash -c 'cat > /home/deploy/.mcp.json << '\''ENDJSON'\''
{
  \"mcpServers\": {
    \"plane-mcp\": {
      \"command\": \"/home/deploy/.local/bin/uvx\",
      \"args\": [\"--python\", \"3.12\", \"plane-mcp-server\", \"stdio\"],
      \"env\": {
        \"PLANE_API_KEY\": \"plane_api_e0f73340ecb248f6a51a1e39a6b880cd\",
        \"PLANE_WORKSPACE_SLUG\": \"devpanl\",
        \"PLANE_BASE_URL\": \"https://plane.devpanl.dev\"
      }
    },
    \"github-mcp\": {
      \"command\": \"npx\",
      \"args\": [\"-y\", \"@modelcontextprotocol/server-github\"],
      \"env\": {
        \"GITHUB_PERSONAL_ACCESS_TOKEN\": \"<REDACTED>\"
      }
    },
    \"devpanel-mcp\": {
      \"command\": \"node\",
      \"args\": [\"/home/deploy/projects/dev-panel/src/mcp/server.js\"],
      \"env\": {
        \"DEVPANEL_STORAGE\": \"/home/deploy/projects/dev-panel/storage\",
        \"REDIS_HOST\": \"77.42.46.87\",
        \"REDIS_PORT\": \"6379\",
        \"WORKER_API\": \"http://localhost:3099\"
      }
    }
  }
}
ENDJSON'"
```

- [ ] **Step 2: Restart Shelly to pick up new MCP**

```bash
ssh -i ~/.ssh/hetzner-vps root@62.238.0.167 "sudo -u deploy tmux -L deploy kill-session -t shelly; sudo -u deploy bash -c 'export HOME=/home/deploy; tmux -L deploy new-session -d -s shelly \"TELEGRAM_BOT_TOKEN=8661116721:AAHp8SszFDQoG-rK0JbmJ6-5tIYDcQzuKqI PATH=/home/deploy/.bun/bin:/home/deploy/.local/bin:/home/deploy/.npm-global/bin:/usr/local/bin:/usr/bin:/bin claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions\"'"
```

- [ ] **Step 3: Verify all MCPs connected**

Send `/mcp` in Shelly and check plane-mcp, github-mcp, devpanel-mcp all show `✔ connected`.

---

## Task 12: End-to-end test (DEVPA-31)

- [ ] **Step 1: Test enqueue via Telegram**

Send to Shelly on Telegram:

> "Enqueue un job builder pour la tâche DEVPA-45 — Créer les SOUL files des agents, priority p1, skills agent-builder"

Shelly should call `enqueue_job` via MCP devpanel.

- [ ] **Step 2: Verify job appears in dashboard**

Open the DevPanel dashboard Queue Monitor view and verify the job shows up in the agents queue.

- [ ] **Step 3: Verify worker picks up the job**

```bash
ssh -i ~/.ssh/hetzner-vps root@62.238.0.167 "journalctl -u devpanel-worker -f --no-pager" 
```

Expected: `[Worker] Starting job ... — builder:DEVPA-45`

- [ ] **Step 4: Verify Telegram notification on completion**

Shelly should notify on Telegram when the job completes or fails.

- [ ] **Step 5: Test mode switch**

Send to Shelly: "je vais dormir"
→ Shelly calls `set_mode("autonomous")`

Send to Shelly: "je suis là"  
→ Shelly calls `set_mode("collaborative")` + delivers morning review

---

## Execution Order

```
Task 1:  Redis expose (infra)
Task 2:  bullmq.js agents queue (code)
Task 3:  prompt-builder.js (code)
Task 4:  worker/index.js (code)
Task 5:  worker/api.js (code)
Task 6:  crons.js (code)
Task 7:  MCP tools (code)
Task 8:  API endpoints (code)
Task 9:  SOUL files (content)
Task 10: systemd service (infra)
Task 11: MCP config for Shelly (infra)
Task 12: E2E test (validation)
```

Tasks 2-9 can be parallelized (independent code changes). Tasks 1, 10, 11 are infra and must happen in order. Task 12 requires everything.
