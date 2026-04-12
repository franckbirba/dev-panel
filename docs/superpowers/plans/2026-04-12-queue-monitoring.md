# Queue Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add BullMQ job monitoring to the DevPanel dashboard — summary widget in Dashboard tab + standalone `/queues` page with full job management and admin actions.

**Architecture:** Backend adds 9 REST endpoints for queue/job CRUD and a SSE `queue:update` channel broadcasting every 5s. Frontend adds `wouter` routing, a summary widget in the dashboard, and a full `/queues` page with queue cards, job lists, and job detail panel. Read endpoints use project auth, action endpoints use admin auth.

**Tech Stack:** Express, BullMQ, wouter, React, Tailwind, existing shadcn components

**Spec:** `docs/superpowers/specs/2026-04-12-queue-monitoring-design.md`

---

### Task 1: Add queue REST endpoints to the backend

**Files:**
- Modify: `src/server/routes.js:131-164` (existing queue/DLQ endpoints section)
- Modify: `src/server/bullmq.js` (add helper functions)

- [ ] **Step 1: Add queue helper functions to bullmq.js**

Add these exports at the end of `src/server/bullmq.js` (before the final `export { QUEUES }`):

```js
/**
 * Get jobs from a queue filtered by state
 * @param {string} queueName - Queue name
 * @param {string} status - Job state (waiting, active, delayed, failed, completed)
 * @param {number} start - Pagination start
 * @param {number} limit - Max jobs to return
 * @returns {Promise<Array>} Jobs
 */
export async function getQueueJobs(queueName, status = 'waiting', start = 0, limit = 50) {
  const queue = getQueue(queueName);
  const jobs = await queue.getJobs([status], start, start + limit - 1);

  return jobs.map(job => ({
    id: job.id,
    name: job.name,
    status,
    data: JSON.stringify(job.data).length > 1024
      ? JSON.parse(JSON.stringify(job.data).slice(0, 1024) + '..."}}')
      : job.data,
    attempts: job.attemptsMade,
    max_attempts: job.opts?.attempts,
    timestamp: job.timestamp,
    processed_on: job.processedOn,
    finished_on: job.finishedOn,
    progress: job.progress,
    failed_reason: job.failedReason,
  }));
}

/**
 * Get full job detail
 * @param {string} queueName - Queue name
 * @param {string} jobId - Job ID
 * @returns {Promise<Object|null>} Full job data
 */
export async function getJobDetail(queueName, jobId) {
  const queue = getQueue(queueName);
  const job = await queue.getJob(jobId);

  if (!job) return null;

  const state = await job.getState();

  return {
    id: job.id,
    name: job.name,
    status: state,
    data: job.data,
    opts: job.opts,
    attempts: job.attemptsMade,
    max_attempts: job.opts?.attempts,
    timestamp: job.timestamp,
    processed_on: job.processedOn,
    finished_on: job.finishedOn,
    progress: job.progress,
    failed_reason: job.failedReason,
    stacktrace: job.stacktrace,
    return_value: job.returnvalue,
  };
}

/**
 * Validate queue name against known queues
 * @param {string} name - Queue name to validate
 * @returns {string|null} Full queue name or null
 */
export function resolveQueueName(name) {
  // Accept short names (tickets) or full names (devpanel:tickets)
  const match = Object.entries(QUEUES).find(
    ([key, fullName]) => key === name || fullName === name
  );
  return match ? match[1] : null;
}
```

- [ ] **Step 2: Add the 9 queue endpoints to routes.js**

In `src/server/routes.js`, add these routes after the existing DLQ retry endpoint (line ~164), before the `// Metrics` section:

```js
  // ============================================================================
  // QUEUE MONITORING ENDPOINTS
  // ============================================================================

  // Queue name validation middleware
  async function resolveQueue(req, res, next) {
    const { resolveQueueName } = await import('./bullmq.js');
    const fullName = resolveQueueName(req.params.name);
    if (!fullName) {
      return res.status(404).json({ error: `Unknown queue: ${req.params.name}` });
    }
    req.queueName = fullName;
    next();
  }

  // List all queues with counts (project auth)
  router.get('/queues', authenticateProject, async (req, res) => {
    try {
      const { getAllQueuesHealth } = await import('./bullmq.js');
      const health = await getAllQueuesHealth();
      res.json(health);
    } catch (error) {
      if (error.message?.includes('ECONNREFUSED') || error.message?.includes('NOAUTH')) {
        return res.status(503).json({ error: 'Redis unavailable', status: 'unreachable' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // List jobs in a queue (project auth)
  router.get('/queues/:name/jobs', authenticateProject, resolveQueue, async (req, res) => {
    try {
      const { getQueueJobs } = await import('./bullmq.js');
      const { status = 'waiting', start = '0', limit = '50' } = req.query;
      const jobs = await getQueueJobs(req.queueName, status, parseInt(start), parseInt(limit));
      res.json({ queue: req.queueName, status, jobs });
    } catch (error) {
      if (error.message?.includes('ECONNREFUSED')) {
        return res.status(503).json({ error: 'Redis unavailable' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Get job detail (project auth)
  router.get('/queues/:name/jobs/:id', authenticateProject, resolveQueue, async (req, res) => {
    try {
      const { getJobDetail } = await import('./bullmq.js');
      const job = await getJobDetail(req.queueName, req.params.id);
      if (!job) {
        return res.status(404).json({ error: `Job ${req.params.id} not found` });
      }
      res.json(job);
    } catch (error) {
      if (error.message?.includes('ECONNREFUSED')) {
        return res.status(503).json({ error: 'Redis unavailable' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Pause queue (admin auth)
  router.post('/queues/:name/pause', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      await queue.pause();
      res.json({ message: `Queue ${req.queueName} paused` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Resume queue (admin auth)
  router.post('/queues/:name/resume', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      await queue.resume();
      res.json({ message: `Queue ${req.queueName} resumed` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Clean queue (admin auth)
  router.post('/queues/:name/clean', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      const { grace = '0', status = 'completed', limit = '100' } = req.body;
      const removed = await queue.clean(parseInt(grace), parseInt(limit), status);
      res.json({ message: `Cleaned ${removed.length} ${status} jobs`, removed: removed.length });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Retry a failed job (admin auth)
  router.post('/queues/:name/jobs/:id/retry', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      const job = await queue.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: `Job ${req.params.id} not found` });
      }
      await job.retry();
      res.json({ message: `Job ${req.params.id} retried` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Remove a job (admin auth)
  router.delete('/queues/:name/jobs/:id', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      const job = await queue.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: `Job ${req.params.id} not found` });
      }
      await job.remove();
      res.json({ message: `Job ${req.params.id} removed` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Promote a delayed job (admin auth)
  router.post('/queues/:name/jobs/:id/promote', authenticateAdmin, resolveQueue, async (req, res) => {
    try {
      const { getQueue } = await import('./bullmq.js');
      const queue = getQueue(req.queueName);
      const job = await queue.getJob(req.params.id);
      if (!job) {
        return res.status(404).json({ error: `Job ${req.params.id} not found` });
      }
      await job.promote();
      res.json({ message: `Job ${req.params.id} promoted` });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
```

- [ ] **Step 3: Commit**

```bash
git add src/server/bullmq.js src/server/routes.js
git commit -m "feat(api): add 9 queue monitoring endpoints with job CRUD"
```

---

### Task 2: Add SSE queue:update broadcasting

**Files:**
- Modify: `src/server/index.js:91-102` (BullMQ monitoring section in startServer)

- [ ] **Step 1: Add SSE queue update interval in startServer**

In `src/server/index.js`, inside the `if (process.env.ENABLE_BULLMQ === 'true')` block (line 92), after the existing monitorQueue loop, add the SSE broadcasting:

```js
        // SSE broadcast of queue health every 5s
        const { broadcast } = await import('./sse.js');
        let lastQueueSnapshot = null;

        const queueUpdateInterval = setInterval(async () => {
          try {
            const { getAllQueuesHealth } = await import('./bullmq.js');
            const health = await getAllQueuesHealth();
            const snapshot = JSON.stringify(health);

            // Only broadcast on change
            if (snapshot !== lastQueueSnapshot) {
              lastQueueSnapshot = snapshot;
              broadcast('queue:update', health);
            }
          } catch {
            // Redis may be down — broadcast unreachable status
            const unreachable = { status: 'unreachable', timestamp: new Date().toISOString() };
            const snapshot = JSON.stringify(unreachable);
            if (snapshot !== lastQueueSnapshot) {
              lastQueueSnapshot = snapshot;
              broadcast('queue:update', unreachable);
            }
          }
        }, 5000);

        console.log('✓ Queue SSE broadcasting started (5s interval)');
```

Also add cleanup of this interval in the SIGTERM handler (line ~106). Add before `server.close(...)`:

```js
        clearInterval(queueUpdateInterval);
```

Note: The `queueUpdateInterval` needs to be accessible from the SIGTERM handler. Hoist it to the `startServer` scope by declaring `let queueUpdateInterval = null;` at the top of `startServer`, then assign inside the BullMQ block.

- [ ] **Step 2: Commit**

```bash
git add src/server/index.js
git commit -m "feat(sse): broadcast queue:update every 5s with diff check"
```

---

### Task 3: Install wouter and add routing to the dashboard

**Files:**
- Modify: `package.json` (add wouter)
- Modify: `src/dashboard/app.jsx` (add routing)

- [ ] **Step 1: Install wouter**

```bash
npm install wouter
```

- [ ] **Step 2: Add wouter routing to app.jsx**

Replace the content of `src/dashboard/app.jsx` with routing. The key changes:
- Import `Route` and `Link` from wouter, setting base to `/dashboard`
- The main dashboard renders at `/dashboard/` (root)
- The queues page renders at `/dashboard/queues`
- All existing state/logic stays the same

```jsx
import { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Router, Route, Switch } from "wouter";
import "./app.css";
import { TabBar } from "@/components/tab-bar";
import { CommandDock } from "@/components/command-dock";
import { InboxView } from "@/views/inbox-view";
import { DashboardView } from "@/views/dashboard-view";
import { SettingsView } from "@/views/settings-view";
import { QueuesView } from "@/views/queues-view";

function App() {
  const [activeTab, setActiveTab] = useState("inbox");
  const [filter, setFilter] = useState(null);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("devpanel_api_key") || "");
  const [sseConnected, setSseConnected] = useState(false);
  const [activities, setActivities] = useState([]);
  const [stats, setStats] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [queueHealth, setQueueHealth] = useState(null);
  const sseRef = useRef(null);

  const apiUrl = window.location.origin;

  function handleApiKeySubmit(e) {
    e.preventDefault();
    const key = e.target.elements.apikey.value.trim();
    if (key) {
      localStorage.setItem("devpanel_api_key", key);
      setApiKey(key);
    }
  }

  useEffect(() => {
    if (!apiKey) return;
    fetch(`${apiUrl}/api/activity`, { headers: { "X-API-Key": apiKey } })
      .then((r) => (r.ok ? r.json() : []))
      .then(setActivities)
      .catch(() => {});
  }, [apiKey, apiUrl]);

  useEffect(() => {
    if (!apiKey) return;
    fetch(`${apiUrl}/api/stats`, { headers: { "X-API-Key": apiKey } })
      .then((r) => (r.ok ? r.json() : null))
      .then(setStats)
      .catch(() => {});
  }, [apiKey, apiUrl, refreshKey]);

  useEffect(() => {
    if (!apiKey) return;

    function connect() {
      const es = new EventSource(`${apiUrl}/api/events?api_key=${apiKey}`);
      sseRef.current = es;

      es.onopen = () => setSseConnected(true);
      es.onerror = () => {
        setSseConnected(false);
        es.close();
        setTimeout(connect, 5000);
      };

      es.addEventListener("ticket:created", (e) => {
        const data = JSON.parse(e.data);
        setActivities((prev) => [
          { action: "created", detail: `${data.type}: ${data.title}`, ticket_id: data.id, created_at: new Date().toISOString() },
          ...prev.slice(0, 49),
        ]);
        setRefreshKey((k) => k + 1);
      });

      es.addEventListener("ticket:published", (e) => {
        const data = JSON.parse(e.data);
        setActivities((prev) => [
          { action: "published", detail: `→ GitHub issue #${data.issueNumber}`, ticket_id: data.id, created_at: new Date().toISOString() },
          ...prev.slice(0, 49),
        ]);
        setRefreshKey((k) => k + 1);
      });

      es.addEventListener("ticket:updated", (e) => {
        const data = JSON.parse(e.data);
        setActivities((prev) => [
          { action: data.status || "updated", detail: `Ticket #${data.id}`, ticket_id: data.id, created_at: new Date().toISOString() },
          ...prev.slice(0, 49),
        ]);
        setRefreshKey((k) => k + 1);
      });

      // Queue health SSE
      es.addEventListener("queue:update", (e) => {
        const data = JSON.parse(e.data);
        setQueueHealth(data);
      });
    }

    connect();
    return () => { sseRef.current?.close(); };
  }, [apiKey, apiUrl]);

  if (!apiKey) {
    return (
      <div className="flex items-center justify-center h-screen bg-background empty-state">
        <form onSubmit={handleApiKeySubmit} className="card-glow flex flex-col gap-5 p-8 rounded-xl max-w-sm w-full">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold tracking-tight">DevPanel</h2>
            <p className="text-[13px] text-muted-foreground">Enter your API key to connect.</p>
          </div>
          <input
            name="apikey"
            type="password"
            placeholder="dp_..."
            autoComplete="off"
            autoFocus
            className="h-9 px-3 rounded-lg border border-border bg-background text-foreground font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring/60 transition-all placeholder:text-muted-foreground/40"
          />
          <button type="submit" className="h-9 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 transition-colors cursor-pointer">
            Connect
          </button>
        </form>
      </div>
    );
  }

  const tabStats = stats?.stats
    ? { pending: stats.stats.pending, bugs: 0, features: 0 }
    : {};

  return (
    <Router base="/dashboard">
      <Switch>
        <Route path="/queues">
          <QueuesView apiUrl={apiUrl} apiKey={apiKey} queueHealth={queueHealth} sseConnected={sseConnected} />
        </Route>
        <Route>
          <div className="flex flex-col h-screen bg-background">
            <TabBar
              activeTab={activeTab}
              onTabChange={setActiveTab}
              stats={tabStats}
              activeFilter={filter}
              onFilterChange={setFilter}
            />
            <div className="flex-1 overflow-hidden">
              {activeTab === "inbox" && <InboxView apiUrl={apiUrl} apiKey={apiKey} filter={filter} refreshKey={refreshKey} />}
              {activeTab === "dashboard" && <DashboardView apiUrl={apiUrl} apiKey={apiKey} activities={activities} refreshKey={refreshKey} queueHealth={queueHealth} />}
              {activeTab === "settings" && <SettingsView apiUrl={apiUrl} apiKey={apiKey} />}
            </div>
            <CommandDock
              projectName={stats?.project}
              sseConnected={sseConnected}
              ticketCount={stats?.stats?.total}
            />
          </div>
        </Route>
      </Switch>
    </Router>
  );
}

createRoot(document.getElementById("root")).render(<App />);
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json src/dashboard/app.jsx
git commit -m "feat(dashboard): add wouter routing and queue:update SSE listener"
```

---

### Task 4: Create the QueueSummary widget for the Dashboard tab

**Files:**
- Create: `src/dashboard/components/queue-summary.jsx`
- Modify: `src/dashboard/views/dashboard-view.jsx:26` (add prop and render widget)

- [ ] **Step 1: Create queue-summary.jsx**

```jsx
import { StatusChip } from "@/components/status-chip";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";

const statusStyles = {
  healthy: "healthy",
  warning: "warning",
  critical: "bug",
  unreachable: "rejected",
};

function QueueMiniCard({ queue }) {
  const c = queue.counts || {};
  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-border/50 last:border-0">
      <StatusChip type={statusStyles[queue.status] || "pending"} label={queue.status} />
      <span className="flex-1 text-foreground text-[13px] font-mono font-medium truncate">
        {queue.queue.replace("devpanel:", "")}
      </span>
      <div className="flex items-center gap-2">
        {c.active > 0 && (
          <Badge variant="outline" className="font-mono text-[10px] bg-info/10 text-info border-info/20 px-1.5 py-0">
            {c.active} active
          </Badge>
        )}
        {c.waiting > 0 && (
          <Badge variant="outline" className="font-mono text-[10px] bg-warning/10 text-warning border-warning/20 px-1.5 py-0">
            {c.waiting} waiting
          </Badge>
        )}
        {c.failed > 0 && (
          <Badge variant="outline" className="font-mono text-[10px] bg-error/10 text-error border-error/20 px-1.5 py-0">
            {c.failed} failed
          </Badge>
        )}
        {c.delayed > 0 && (
          <Badge variant="outline" className="font-mono text-[10px] bg-muted text-muted-foreground border-border px-1.5 py-0">
            {c.delayed} delayed
          </Badge>
        )}
      </div>
    </div>
  );
}

export function QueueSummary({ queueHealth }) {
  if (!queueHealth || queueHealth.status === "unreachable") {
    return (
      <div className="card-glow rounded-xl p-5">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-foreground text-[13px] font-semibold tracking-wide uppercase">Queues</h3>
          <div className="flex-1 h-px bg-border/50" />
          <span className="text-muted-foreground/40 text-[10px] font-mono">disconnected</span>
        </div>
        <div className="empty-state flex items-center justify-center py-8 rounded-lg">
          <span className="text-muted-foreground/50 text-xs font-mono">Redis unreachable</span>
        </div>
      </div>
    );
  }

  return (
    <div className="card-glow rounded-xl p-5">
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-foreground text-[13px] font-semibold tracking-wide uppercase">Queues</h3>
        <div className="flex-1 h-px bg-border/50" />
        <StatusChip type={statusStyles[queueHealth.status] || "pending"} label={queueHealth.status} />
        <Link to="/queues" className="text-info text-[11px] font-mono hover:underline cursor-pointer">
          Open full view →
        </Link>
      </div>
      <div className="flex flex-col">
        {(queueHealth.queues || []).map((q) => (
          <QueueMiniCard key={q.queue} queue={q} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add QueueSummary to dashboard-view.jsx**

In `src/dashboard/views/dashboard-view.jsx`:

Add the import at the top:
```jsx
import { QueueSummary } from "@/components/queue-summary";
```

Change the function signature to accept `queueHealth`:
```jsx
export function DashboardView({ apiUrl, apiKey, activities, refreshKey, queueHealth }) {
```

Add the widget after the closing `</div>` of the two-column grid (after line 96), before the final `</div></ScrollArea>`:
```jsx
        {/* Queue summary */}
        <QueueSummary queueHealth={queueHealth} />
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/queue-summary.jsx src/dashboard/views/dashboard-view.jsx
git commit -m "feat(dashboard): add queue summary widget to Dashboard tab"
```

---

### Task 5: Create the QueueCard component

**Files:**
- Create: `src/dashboard/components/queue-card.jsx`

- [ ] **Step 1: Create queue-card.jsx**

```jsx
import { useState } from "react";
import { StatusChip } from "@/components/status-chip";
import { Badge } from "@/components/ui/badge";

const statusStyles = {
  healthy: "healthy",
  warning: "warning",
  critical: "bug",
  unreachable: "rejected",
};

const countEntries = [
  { key: "waiting", label: "Waiting", color: "text-warning" },
  { key: "active", label: "Active", color: "text-info" },
  { key: "delayed", label: "Delayed", color: "text-muted-foreground" },
  { key: "failed", label: "Failed", color: "text-error" },
  { key: "completed", label: "Done", color: "text-success" },
];

export function QueueCard({ queue, selected, onSelect, apiUrl, adminKey }) {
  const [acting, setActing] = useState(false);
  const c = queue.counts || {};
  const shortName = queue.queue.replace("devpanel:", "");

  async function adminAction(action) {
    setActing(true);
    try {
      await fetch(`${apiUrl}/api/queues/${shortName}/${action}`, {
        method: "POST",
        headers: { "X-Admin-Key": adminKey, "Content-Type": "application/json" },
        body: action === "clean" ? JSON.stringify({ status: "completed" }) : undefined,
      });
    } catch {
      // silently fail — next SSE update will show current state
    }
    setActing(false);
  }

  return (
    <button
      onClick={() => onSelect(shortName)}
      className={`card-glow rounded-xl p-5 text-left cursor-pointer transition-all ${
        selected ? "ring-2 ring-ring/60" : "hover:ring-1 hover:ring-ring/30"
      }`}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-foreground text-sm font-mono font-semibold">{shortName}</span>
        <div className="flex-1" />
        <StatusChip type={statusStyles[queue.status] || "pending"} label={queue.status} />
        {queue.paused && (
          <Badge variant="outline" className="font-mono text-[10px] bg-warning/10 text-warning border-warning/20 px-1.5 py-0">
            PAUSED
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-5 gap-2">
        {countEntries.map(({ key, label, color }) => (
          <div key={key} className="flex flex-col items-center bg-secondary/50 rounded-lg py-2">
            <span className={`text-lg font-bold ${color}`}>{c[key] || 0}</span>
            <span className="text-muted-foreground/60 text-[9px] font-mono mt-0.5">{label}</span>
          </div>
        ))}
      </div>
      {adminKey && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-border/50" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => adminAction(queue.paused ? "resume" : "pause")}
            disabled={acting}
            className="text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
          >
            {queue.paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={() => adminAction("clean")}
            disabled={acting}
            className="text-[11px] font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:opacity-50"
          >
            Clean done
          </button>
        </div>
      )}
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/queue-card.jsx
git commit -m "feat(dashboard): add QueueCard component with admin actions"
```

---

### Task 6: Create the JobList component

**Files:**
- Create: `src/dashboard/components/job-list.jsx`

- [ ] **Step 1: Create job-list.jsx**

```jsx
import { useState, useEffect } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

const JOB_STATES = ["waiting", "active", "delayed", "failed", "completed"];

function JobRow({ job, onSelect }) {
  const time = job.timestamp ? new Date(job.timestamp).toLocaleTimeString() : "—";
  return (
    <button
      onClick={() => onSelect(job)}
      className="flex items-center gap-3 py-2.5 px-3 border-b border-border/50 last:border-0 hover:bg-secondary/30 transition-colors text-left w-full cursor-pointer"
    >
      <span className="text-foreground text-[12px] font-mono font-medium w-16 shrink-0">#{job.id}</span>
      <span className="flex-1 text-foreground text-[12px] font-mono truncate">{job.name}</span>
      <span className="text-muted-foreground/60 text-[10px] font-mono">{time}</span>
      {job.attempts > 0 && (
        <Badge variant="outline" className="font-mono text-[9px] px-1 py-0">
          {job.attempts}/{job.max_attempts || "∞"}
        </Badge>
      )}
      {job.failed_reason && (
        <span className="text-error text-[10px] font-mono truncate max-w-[200px]">{job.failed_reason}</span>
      )}
    </button>
  );
}

export function JobList({ queueName, apiUrl, apiKey, onSelectJob }) {
  const [activeState, setActiveState] = useState("waiting");
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!queueName) return;
    setLoading(true);
    fetch(`${apiUrl}/api/queues/${queueName}/jobs?status=${activeState}&limit=50`, {
      headers: { "X-API-Key": apiKey },
    })
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((data) => setJobs(data.jobs || []))
      .catch(() => setJobs([]))
      .finally(() => setLoading(false));
  }, [queueName, activeState, apiUrl, apiKey]);

  return (
    <div className="card-glow rounded-xl p-5">
      <Tabs value={activeState} onValueChange={setActiveState}>
        <TabsList variant="line">
          {JOB_STATES.map((state) => (
            <TabsTrigger key={state} value={state} className="text-[12px] font-mono capitalize">
              {state}
            </TabsTrigger>
          ))}
        </TabsList>
        {JOB_STATES.map((state) => (
          <TabsContent key={state} value={state}>
            <ScrollArea className="max-h-[400px]">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <span className="text-muted-foreground/50 text-xs font-mono">Loading...</span>
                </div>
              ) : jobs.length === 0 ? (
                <div className="empty-state flex items-center justify-center py-8 rounded-lg">
                  <span className="text-muted-foreground/50 text-xs font-mono">No {state} jobs</span>
                </div>
              ) : (
                <div className="flex flex-col">
                  {jobs.map((job) => (
                    <JobRow key={job.id} job={job} onSelect={onSelectJob} />
                  ))}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/job-list.jsx
git commit -m "feat(dashboard): add JobList component with state tabs"
```

---

### Task 7: Create the JobDetail panel

**Files:**
- Create: `src/dashboard/components/job-detail.jsx`

- [ ] **Step 1: Create job-detail.jsx**

```jsx
import { useState, useEffect } from "react";
import { StatusChip } from "@/components/status-chip";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

const statusStyles = {
  waiting: "pending",
  active: "created",
  delayed: "synced",
  failed: "bug",
  completed: "published",
};

function DetailRow({ label, children }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-border/50 last:border-0">
      <span className="text-muted-foreground text-[11px] font-mono w-24 shrink-0 pt-0.5">{label}</span>
      <div className="flex-1 text-foreground text-[12px] font-mono break-all">{children}</div>
    </div>
  );
}

export function JobDetail({ queueName, jobId, apiUrl, apiKey, adminKey, onClose }) {
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  useEffect(() => {
    if (!queueName || !jobId) return;
    setLoading(true);
    fetch(`${apiUrl}/api/queues/${queueName}/jobs/${jobId}`, {
      headers: { "X-API-Key": apiKey },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(setJob)
      .catch(() => setJob(null))
      .finally(() => setLoading(false));
  }, [queueName, jobId, apiUrl, apiKey]);

  async function jobAction(action) {
    if (!adminKey) return;
    setActing(true);
    try {
      const method = action === "remove" ? "DELETE" : "POST";
      const url = action === "remove"
        ? `${apiUrl}/api/queues/${queueName}/jobs/${jobId}`
        : `${apiUrl}/api/queues/${queueName}/jobs/${jobId}/${action}`;
      await fetch(url, { method, headers: { "X-Admin-Key": adminKey } });
      onClose();
    } catch {
      // next refresh will show state
    }
    setActing(false);
  }

  if (loading) {
    return (
      <div className="card-glow rounded-xl p-5">
        <span className="text-muted-foreground/50 text-xs font-mono">Loading job...</span>
      </div>
    );
  }

  if (!job) {
    return (
      <div className="card-glow rounded-xl p-5">
        <span className="text-muted-foreground/50 text-xs font-mono">Job not found</span>
      </div>
    );
  }

  return (
    <div className="card-glow rounded-xl p-5">
      <div className="flex items-center gap-3 mb-4">
        <h3 className="text-foreground text-sm font-mono font-semibold">Job #{job.id}</h3>
        <StatusChip type={statusStyles[job.status] || "pending"} label={job.status} />
        <div className="flex-1" />
        {adminKey && (
          <div className="flex gap-2">
            {job.status === "failed" && (
              <button onClick={() => jobAction("retry")} disabled={acting} className="text-[11px] font-mono text-info hover:underline cursor-pointer disabled:opacity-50">
                Retry
              </button>
            )}
            {job.status === "delayed" && (
              <button onClick={() => jobAction("promote")} disabled={acting} className="text-[11px] font-mono text-warning hover:underline cursor-pointer disabled:opacity-50">
                Promote
              </button>
            )}
            <button onClick={() => jobAction("remove")} disabled={acting} className="text-[11px] font-mono text-error hover:underline cursor-pointer disabled:opacity-50">
              Remove
            </button>
          </div>
        )}
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-sm cursor-pointer">×</button>
      </div>

      <ScrollArea className="max-h-[500px]">
        <div className="flex flex-col">
          <DetailRow label="Name">{job.name}</DetailRow>
          <DetailRow label="Attempts">
            {job.attempts}/{job.max_attempts || "∞"}
          </DetailRow>
          <DetailRow label="Created">
            {job.timestamp ? new Date(job.timestamp).toLocaleString() : "—"}
          </DetailRow>
          {job.processed_on && (
            <DetailRow label="Processed">
              {new Date(job.processed_on).toLocaleString()}
            </DetailRow>
          )}
          {job.finished_on && (
            <DetailRow label="Finished">
              {new Date(job.finished_on).toLocaleString()}
            </DetailRow>
          )}
          {job.progress != null && job.progress > 0 && (
            <DetailRow label="Progress">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full bg-info rounded-full" style={{ width: `${job.progress}%` }} />
                </div>
                <span className="text-[10px]">{job.progress}%</span>
              </div>
            </DetailRow>
          )}

          {/* Data */}
          <div className="mt-4">
            <span className="text-muted-foreground text-[11px] font-mono font-semibold uppercase tracking-wide">Data</span>
            <pre className="mt-2 p-3 bg-background rounded-lg text-[11px] font-mono text-foreground/80 overflow-x-auto">
              {JSON.stringify(job.data, null, 2)}
            </pre>
          </div>

          {/* Stacktrace */}
          {job.stacktrace && job.stacktrace.length > 0 && (
            <div className="mt-4">
              <span className="text-error text-[11px] font-mono font-semibold uppercase tracking-wide">Stacktrace</span>
              <pre className="mt-2 p-3 bg-error/5 border border-error/20 rounded-lg text-[11px] font-mono text-error/80 overflow-x-auto whitespace-pre-wrap">
                {job.stacktrace.join("\n")}
              </pre>
            </div>
          )}

          {/* Failed reason */}
          {job.failed_reason && (
            <div className="mt-4">
              <span className="text-error text-[11px] font-mono font-semibold uppercase tracking-wide">Error</span>
              <p className="mt-1 text-error text-[12px] font-mono">{job.failed_reason}</p>
            </div>
          )}

          {/* Return value */}
          {job.return_value != null && (
            <div className="mt-4">
              <span className="text-success text-[11px] font-mono font-semibold uppercase tracking-wide">Return Value</span>
              <pre className="mt-2 p-3 bg-success/5 border border-success/20 rounded-lg text-[11px] font-mono text-success/80 overflow-x-auto">
                {JSON.stringify(job.return_value, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/job-detail.jsx
git commit -m "feat(dashboard): add JobDetail panel with admin actions"
```

---

### Task 8: Create the QueuesView page

**Files:**
- Create: `src/dashboard/views/queues-view.jsx`

- [ ] **Step 1: Create queues-view.jsx**

```jsx
import { useState } from "react";
import { Link } from "wouter";
import { QueueCard } from "@/components/queue-card";
import { JobList } from "@/components/job-list";
import { JobDetail } from "@/components/job-detail";
import { ScrollArea } from "@/components/ui/scroll-area";

export function QueuesView({ apiUrl, apiKey, queueHealth, sseConnected }) {
  const [selectedQueue, setSelectedQueue] = useState(null);
  const [selectedJob, setSelectedJob] = useState(null);
  const [adminKey] = useState(() => localStorage.getItem("devpanel_admin_key") || "");

  const queues = queueHealth?.queues || [];
  const isUnreachable = !queueHealth || queueHealth.status === "unreachable";

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header */}
      <div className="flex items-center h-12 border-b border-border bg-surface px-4 gap-4">
        <Link to="/" className="text-muted-foreground hover:text-foreground text-sm font-mono cursor-pointer">
          ← Dashboard
        </Link>
        <span className="text-border text-[10px]">·</span>
        <h1 className="text-foreground text-[13px] font-semibold tracking-wide">Queue Monitor</h1>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <span className={`w-1 h-1 rounded-full ${sseConnected ? "bg-success animate-pulse" : "bg-error"}`} />
          <span className="text-muted-foreground/40 text-[10px] font-mono">
            {sseConnected ? "live" : "disconnected"}
          </span>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-6 p-6 max-w-[1400px] mx-auto">
          {isUnreachable ? (
            <div className="card-glow rounded-xl p-12">
              <div className="empty-state flex flex-col items-center justify-center gap-3 rounded-lg">
                <span className="text-error text-sm font-mono font-semibold">Redis Unreachable</span>
                <span className="text-muted-foreground/50 text-xs font-mono">Waiting for connection...</span>
              </div>
            </div>
          ) : (
            <>
              {/* Queue cards grid */}
              <div className="grid grid-cols-2 gap-4">
                {queues.map((q) => (
                  <QueueCard
                    key={q.queue}
                    queue={q}
                    selected={selectedQueue === q.queue.replace("devpanel:", "")}
                    onSelect={setSelectedQueue}
                    apiUrl={apiUrl}
                    adminKey={adminKey}
                  />
                ))}
              </div>

              {/* Job list for selected queue */}
              {selectedQueue && (
                <JobList
                  queueName={selectedQueue}
                  apiUrl={apiUrl}
                  apiKey={apiKey}
                  onSelectJob={(job) => setSelectedJob(job)}
                />
              )}

              {/* Job detail panel */}
              {selectedJob && selectedQueue && (
                <JobDetail
                  queueName={selectedQueue}
                  jobId={selectedJob.id}
                  apiUrl={apiUrl}
                  apiKey={apiKey}
                  adminKey={adminKey}
                  onClose={() => setSelectedJob(null)}
                />
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/views/queues-view.jsx
git commit -m "feat(dashboard): add /queues standalone page"
```

---

### Task 9: Wire admin key storage in Settings

**Files:**
- Modify: `src/dashboard/views/settings-view.jsx` (add admin key field)

- [ ] **Step 1: Read settings-view.jsx to understand current structure**

Read `src/dashboard/views/settings-view.jsx` and understand what settings fields exist.

- [ ] **Step 2: Add admin key input**

Add a new section for admin key in the settings view, similar to how the API key works. The admin key should be stored in `localStorage` as `devpanel_admin_key`:

```jsx
// Add this section inside the settings form, after existing fields:
<div className="flex flex-col gap-1">
  <label className="text-[11px] font-medium tracking-wide uppercase text-muted-foreground">Admin Key (optional)</label>
  <p className="text-[11px] text-muted-foreground/60">Required for queue admin actions (pause, retry, clean).</p>
  <input
    name="adminkey"
    type="password"
    defaultValue={localStorage.getItem("devpanel_admin_key") || ""}
    onChange={(e) => {
      const v = e.target.value.trim();
      if (v) localStorage.setItem("devpanel_admin_key", v);
      else localStorage.removeItem("devpanel_admin_key");
    }}
    placeholder="admin key..."
    autoComplete="off"
    className="h-9 px-3 rounded-lg border border-border bg-background text-foreground font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring/60 transition-all placeholder:text-muted-foreground/40"
  />
</div>
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/views/settings-view.jsx
git commit -m "feat(settings): add admin key field for queue management"
```

---

### Task 10: Verify the build

**Files:** none (verification only)

- [ ] **Step 1: Run the Vite build**

```bash
npm run build
```

Expected: build completes without errors.

- [ ] **Step 2: Fix any build errors**

If there are import errors, missing aliases, or type issues, fix them.

- [ ] **Step 3: Commit any fixes**

```bash
git add -u
git commit -m "fix: resolve build errors for queue monitoring"
```
