# PM Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web-based PM dashboard served at `/dashboard` by the existing Express server, replacing CLI commands with a React SPA using the Ink & Wire design system.

**Architecture:** New Express routes serve an HTML shell that loads React 19 via esm.sh import maps. Three tab views (Inbox, Dashboard, Settings) use SSE for real-time updates. Publish/reject logic extracted from CLI into shared services.

**Tech Stack:** Express, React 19 (esm.sh CDN), SSE, SQLite (better-sqlite3), Ink & Wire design tokens

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/dashboard/index.html` | HTML shell with import maps for React via esm.sh |
| Create | `src/dashboard/theme.js` | Ink & Wire design tokens (colors, fonts, spacing) |
| Create | `src/dashboard/app.js` | Root App component, tab state, SSE connection, auth |
| Create | `src/dashboard/components/tab-bar.js` | Top navigation with tab switching + filter pills |
| Create | `src/dashboard/components/command-dock.js` | Bottom bar with context + sync indicator |
| Create | `src/dashboard/components/status-chip.js` | Colored chip for ticket type/status |
| Create | `src/dashboard/components/metric-card.js` | Stat card (label, value, delta, accent) |
| Create | `src/dashboard/components/ticket-row.js` | Single ticket in inbox list |
| Create | `src/dashboard/components/ticket-detail.js` | Full ticket detail with actions |
| Create | `src/dashboard/components/activity-row.js` | Activity feed item |
| Create | `src/dashboard/views/inbox-view.js` | Split pane: ticket list + detail |
| Create | `src/dashboard/views/dashboard-view.js` | Metrics + activity + projects + sync |
| Create | `src/dashboard/views/settings-view.js` | Read-only project config display |
| Create | `src/server/sse.js` | SSE client manager, broadcast, heartbeat |
| Create | `src/server/services.js` | Shared publish/reject logic (used by CLI + API) |
| Modify | `src/server/db.js` | Add `activity_log` table + query functions |
| Modify | `src/server/routes.js` | Add dashboard routes, SSE, activity, publish/reject endpoints |
| Modify | `src/server/index.js` | Mount dashboard static files + HTML route |

---

### Task 1: Design Tokens — theme.js

**Files:**
- Create: `src/dashboard/theme.js`

- [ ] **Step 1: Create theme.js with Ink & Wire tokens**

```js
// src/dashboard/theme.js

export const colors = {
  bg: '#0A0A0B',
  card: '#13131A',
  elevated: '#1C1C26',
  border: '#2A2A3A',
  textPrimary: '#E8E8ED',
  textSecondary: '#8B8B9B',
  textMuted: '#6B6B7B',
  textDim: '#4B4B5B',
  success: '#10B981',
  warning: '#F59E0B',
  error: '#EF4444',
  info: '#3B82F6',
};

export const fonts = {
  headline: "'Epilogue', sans-serif",
  body: "'IBM Plex Sans', sans-serif",
  mono: "'IBM Plex Mono', monospace",
};

export const fontUrls = [
  'https://fonts.googleapis.com/css2?family=Epilogue:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap',
];

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radii = {
  sm: 4,
  md: 6,
  lg: 10,
  xl: 14,
};
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/theme.js
git commit -m "feat(dashboard): add Ink & Wire design tokens"
```

---

### Task 2: HTML Shell — index.html

**Files:**
- Create: `src/dashboard/index.html`

- [ ] **Step 1: Create index.html with esm.sh import maps**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DevPanel — Dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Epilogue:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@19",
      "react-dom": "https://esm.sh/react-dom@19",
      "react-dom/client": "https://esm.sh/react-dom@19/client",
      "react/jsx-runtime": "https://esm.sh/react@19/jsx-runtime"
    }
  }
  </script>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    html, body, #root { height: 100%; width: 100%; overflow: hidden; }
    body { background: #0A0A0B; color: #E8E8ED; font-family: 'IBM Plex Sans', sans-serif; }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: #0A0A0B; }
    ::-webkit-scrollbar-thumb { background: #2A2A3A; border-radius: 3px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/dashboard/assets/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/index.html
git commit -m "feat(dashboard): add HTML shell with esm.sh import maps"
```

---

### Task 3: SSE Server Module

**Files:**
- Create: `src/server/sse.js`

- [ ] **Step 1: Create SSE module**

```js
// src/server/sse.js

const clients = new Set();

export function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':\n\n'); // initial comment to flush headers
  clients.add(res);

  const heartbeat = setInterval(() => {
    res.write(':\n\n');
  }, 30000);

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

export function getClientCount() {
  return clients.size;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/sse.js
git commit -m "feat(server): add SSE broadcast module"
```

---

### Task 4: Activity Log — Database

**Files:**
- Modify: `src/server/db.js`

- [ ] **Step 1: Add activity_log table to initProjectDatabase**

In `src/server/db.js`, inside `initProjectDatabase()` (after the existing `CREATE TABLE` statements around line 147), add:

```js
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL CHECK(action IN ('created', 'published', 'rejected', 'synced', 'updated')),
      ticket_id INTEGER,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_log(created_at);
  `);
```

- [ ] **Step 2: Add logActivity function**

Add after `getStats` function (around line 335):

```js
export function logActivity(storagePath, projectId, { action, ticketId, detail }) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare(
    'INSERT INTO activity_log (action, ticket_id, detail) VALUES (?, ?, ?)'
  );
  return stmt.run(action, ticketId || null, detail || null);
}

export function listActivity(storagePath, projectId, limit = 50) {
  const db = getProjectDatabase(storagePath, projectId);
  const stmt = db.prepare(
    'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?'
  );
  return stmt.all(limit);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/server/db.js
git commit -m "feat(db): add activity_log table and query functions"
```

---

### Task 5: Shared Services — publish & reject

**Files:**
- Create: `src/server/services.js`

- [ ] **Step 1: Create services.js extracting publish/reject logic**

```js
// src/server/services.js

import { getTicket, updateTicket } from './db.js';
import { initGitHub, createIssue, formatTicketAsIssue, getGitHub } from './github.js';
import { logActivity } from './db.js';
import { broadcast } from './sse.js';

export async function publishTicket(storagePath, projectId, ticketId, { githubConfig, title, labels, assignee }) {
  const ticket = getTicket(storagePath, projectId, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  if (ticket.status === 'published') throw new Error(`Ticket ${ticketId} already published`);

  // Initialize GitHub client
  const token = process.env.GITHUB_TOKEN || githubConfig.token;
  if (!token) throw new Error('GitHub token not configured');
  initGitHub(token);

  // Format and create issue
  const issueData = formatTicketAsIssue(ticket, githubConfig);
  if (title) issueData.title = title;
  if (labels) issueData.labels = labels;
  if (assignee) issueData.assignees = [assignee];

  const issue = await createIssue(issueData);

  // Update ticket
  updateTicket(storagePath, projectId, ticketId, {
    status: 'published',
    github_issue_number: issue.number,
    github_issue_url: issue.html_url,
    github_synced_at: new Date().toISOString(),
    reviewed_at: new Date().toISOString(),
  });

  // Log activity + broadcast
  logActivity(storagePath, projectId, {
    action: 'published',
    ticketId,
    detail: `→ GitHub issue #${issue.number}`,
  });
  broadcast('ticket:published', { id: ticketId, issueNumber: issue.number, issueUrl: issue.html_url });

  return issue;
}

export function rejectTicket(storagePath, projectId, ticketId, reason = 'Not applicable') {
  const ticket = getTicket(storagePath, projectId, ticketId);
  if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
  if (ticket.status === 'rejected') throw new Error(`Ticket ${ticketId} already rejected`);

  updateTicket(storagePath, projectId, ticketId, {
    status: 'rejected',
    rejection_reason: reason,
    reviewed_at: new Date().toISOString(),
  });

  logActivity(storagePath, projectId, {
    action: 'rejected',
    ticketId,
    detail: reason,
  });
  broadcast('ticket:updated', { id: ticketId, status: 'rejected' });

  return { id: ticketId, status: 'rejected' };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/server/services.js
git commit -m "feat(server): extract publish/reject into shared services"
```

---

### Task 6: Server Routes — Dashboard + API

**Files:**
- Modify: `src/server/routes.js`
- Modify: `src/server/index.js`

- [ ] **Step 1: Add new API routes to routes.js**

At the top of `routes.js`, add imports:

```js
import { logActivity, listActivity } from './db.js';
import { addClient } from './sse.js';
import { publishTicket, rejectTicket } from './services.js';
```

Inside `createRouter()`, before `return router;` (around line 482), add:

```js
  // Activity feed
  router.get('/activity', authenticateProject, (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const activity = listActivity(storagePath, req.project.id, limit);
      res.json(activity);
    } catch (error) {
      console.error('Error listing activity:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // SSE events stream
  router.get('/events', authenticateProject, (req, res) => {
    addClient(res);
  });

  // Publish ticket to GitHub
  router.post('/tickets/:id/publish', authenticateProject, async (req, res) => {
    try {
      const ticketId = parseInt(req.params.id);
      const { title, labels, assignee } = req.body;
      const config = JSON.parse(
        (await import('fs')).readFileSync('.devpanelrc.json', 'utf-8')
      );
      const issue = await publishTicket(storagePath, req.project.id, ticketId, {
        githubConfig: config.github,
        title,
        labels,
        assignee,
      });
      res.json({ message: 'Ticket published', issue: { number: issue.number, url: issue.html_url } });
    } catch (error) {
      console.error('Error publishing ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Reject ticket
  router.post('/tickets/:id/reject', authenticateProject, (req, res) => {
    try {
      const ticketId = parseInt(req.params.id);
      const { reason } = req.body;
      const result = rejectTicket(storagePath, req.project.id, ticketId, reason);
      res.json(result);
    } catch (error) {
      console.error('Error rejecting ticket:', error);
      res.status(500).json({ error: error.message });
    }
  });
```

- [ ] **Step 2: Add activity logging to existing ticket creation**

In the existing `POST /tickets` handler (around line 319 in routes.js), after the `createTicket` call and before `res.status(201).json(...)`, add:

```js
      logActivity(storagePath, req.project.id, {
        action: 'created',
        ticketId: id,
        detail: `${ticketData.type}: ${ticketData.title}`,
      });
      broadcast('ticket:created', { id, type: ticketData.type, title: ticketData.title });
```

Also add at the top of the file:

```js
import { broadcast } from './sse.js';
```

- [ ] **Step 3: Mount dashboard in index.js**

In `src/server/index.js`, add after line 4:

```js
import { fileURLToPath } from 'url';
import path from 'path';
```

Inside `createServer()`, after `app.use('/api', createRouter(config));` (line 45), add:

```js
  // Dashboard SPA
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dashboardDir = path.join(__dirname, '..', 'dashboard');

  // Serve JS modules from dashboard directory
  app.use('/dashboard/assets', express.static(dashboardDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js')) {
        res.setHeader('Content-Type', 'application/javascript');
      }
    },
  }));

  // Serve dashboard HTML for /dashboard route
  app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(dashboardDir, 'index.html'));
  });
```

- [ ] **Step 4: Commit**

```bash
git add src/server/routes.js src/server/index.js
git commit -m "feat(server): add dashboard routes, SSE, activity, publish/reject endpoints"
```

---

### Task 7: StatusChip Component

**Files:**
- Create: `src/dashboard/components/status-chip.js`

- [ ] **Step 1: Create status-chip.js**

```js
// src/dashboard/components/status-chip.js
import { createElement as h } from 'react';
import { colors, fonts, radii } from '../theme.js';

const chipColors = {
  bug: colors.error,
  feature: colors.info,
  published: colors.success,
  rejected: colors.textMuted,
  pending: colors.warning,
  synced: colors.warning,
  created: colors.info,
  updated: colors.textSecondary,
};

export function StatusChip({ label, type }) {
  const color = chipColors[type] || colors.textMuted;
  return h('span', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: radii.sm,
      backgroundColor: color + '26', // 15% opacity
      color,
      fontSize: 10,
      fontFamily: fonts.mono,
      fontWeight: 700,
      letterSpacing: '0.02em',
      lineHeight: '18px',
      whiteSpace: 'nowrap',
    },
  }, label || type);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/status-chip.js
git commit -m "feat(dashboard): add StatusChip component"
```

---

### Task 8: MetricCard Component

**Files:**
- Create: `src/dashboard/components/metric-card.js`

- [ ] **Step 1: Create metric-card.js**

```js
// src/dashboard/components/metric-card.js
import { createElement as h } from 'react';
import { colors, fonts, radii, spacing } from '../theme.js';

export function MetricCard({ label, value, delta, accentColor }) {
  const accent = accentColor || colors.info;
  return h('div', {
    style: {
      backgroundColor: colors.card,
      borderRadius: radii.lg,
      padding: `${spacing.md}px ${spacing.lg}px`,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      flex: 1,
      minWidth: 200,
    },
  },
    h('div', { style: { width: '100%', height: 3, backgroundColor: accent, borderRadius: 2 } }),
    h('span', { style: { color: colors.textMuted, fontSize: 12, fontFamily: fonts.body } }, label),
    h('span', { style: { color: colors.textPrimary, fontSize: 32, fontFamily: fonts.headline, fontWeight: 700 } }, value),
    h('span', { style: { color: colors.textSecondary, fontSize: 11, fontFamily: fonts.mono } }, delta),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/metric-card.js
git commit -m "feat(dashboard): add MetricCard component"
```

---

### Task 9: TabBar Component

**Files:**
- Create: `src/dashboard/components/tab-bar.js`

- [ ] **Step 1: Create tab-bar.js**

```js
// src/dashboard/components/tab-bar.js
import { createElement as h } from 'react';
import { colors, fonts } from '../theme.js';

function Tab({ label, active, badge, onClick }) {
  return h('button', {
    onClick,
    style: {
      background: 'none',
      border: 'none',
      borderBottom: active ? `2px solid ${colors.success}` : '2px solid transparent',
      color: active ? colors.textPrimary : colors.textDim,
      fontFamily: fonts.body,
      fontSize: 13,
      fontWeight: active ? 600 : 400,
      padding: '10px 16px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 6,
    },
  },
    label,
    badge != null && h('span', {
      style: {
        color: colors.success,
        opacity: 0.6,
        fontSize: 12,
        fontFamily: fonts.mono,
      },
    }, badge),
  );
}

function FilterPill({ label, count, active, color, onClick }) {
  return h('button', {
    onClick,
    style: {
      background: 'none',
      border: 'none',
      color: colors.textSecondary,
      fontFamily: fonts.body,
      fontSize: 12,
      padding: '4px 10px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: 5,
    },
  },
    h('span', { style: { width: 6, height: 6, borderRadius: '50%', backgroundColor: color, display: 'inline-block' } }),
    `${label} ${count}`,
  );
}

export function TabBar({ activeTab, onTabChange, stats, activeFilter, onFilterChange }) {
  const pendingCount = stats?.pending || 0;
  const bugCount = stats?.bugs || 0;
  const featureCount = stats?.features || 0;

  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      height: 44,
      borderBottom: `1px solid ${colors.border}`,
      backgroundColor: colors.bg,
      padding: '0 16px',
    },
  },
    h(Tab, { label: 'Inbox', active: activeTab === 'inbox', badge: pendingCount || null, onClick: () => onTabChange('inbox') }),
    h(Tab, { label: 'Dashboard', active: activeTab === 'dashboard', onClick: () => onTabChange('dashboard') }),
    h(Tab, { label: 'Settings', active: activeTab === 'settings', onClick: () => onTabChange('settings') }),
    // Spacer
    h('div', { style: { flex: 1 } }),
    // Filter pills (visible on inbox tab)
    activeTab === 'inbox' && h('div', { style: { display: 'flex', gap: 4 } },
      h(FilterPill, { label: 'Bugs', count: bugCount, color: colors.error, onClick: () => onFilterChange('bug') }),
      h(FilterPill, { label: 'Features', count: featureCount, color: colors.info, onClick: () => onFilterChange('feature') }),
      h(FilterPill, { label: 'Pending', count: pendingCount, color: colors.warning, onClick: () => onFilterChange('pending') }),
    ),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/tab-bar.js
git commit -m "feat(dashboard): add TabBar component"
```

---

### Task 10: CommandDock Component

**Files:**
- Create: `src/dashboard/components/command-dock.js`

- [ ] **Step 1: Create command-dock.js**

```js
// src/dashboard/components/command-dock.js
import { createElement as h } from 'react';
import { colors, fonts } from '../theme.js';

export function CommandDock({ projectName, sseConnected, ticketCount }) {
  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      height: 56,
      padding: '0 20px',
      borderTop: `1px solid ${colors.border}`,
      backgroundColor: colors.bg,
      gap: 16,
    },
  },
    // Project context
    h('span', { style: { color: colors.textMuted, fontSize: 12, fontFamily: fonts.mono } },
      `[${projectName || 'dev-panel'}]`
    ),
    h('span', { style: { color: colors.textDim, fontSize: 12, fontFamily: fonts.mono } }, '|'),
    h('span', { style: { color: colors.textSecondary, fontSize: 12, fontFamily: fonts.mono } },
      `${ticketCount || 0} tickets`
    ),
    // Spacer
    h('div', { style: { flex: 1 } }),
    // SSE status indicator
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      h('span', {
        style: {
          width: 6,
          height: 6,
          borderRadius: '50%',
          backgroundColor: sseConnected ? colors.success : colors.error,
        },
      }),
      h('span', { style: { color: colors.textMuted, fontSize: 10, fontFamily: fonts.mono } },
        sseConnected ? 'live' : 'disconnected'
      ),
    ),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/command-dock.js
git commit -m "feat(dashboard): add CommandDock component"
```

---

### Task 11: TicketRow + TicketDetail Components

**Files:**
- Create: `src/dashboard/components/ticket-row.js`
- Create: `src/dashboard/components/ticket-detail.js`

- [ ] **Step 1: Create ticket-row.js**

```js
// src/dashboard/components/ticket-row.js
import { createElement as h } from 'react';
import { colors, fonts } from '../theme.js';
import { StatusChip } from './status-chip.js';

export function TicketRow({ ticket, selected, onClick }) {
  const priorityColors = { low: colors.info, medium: colors.warning, high: colors.error, critical: colors.error };
  const context = typeof ticket.context === 'string' ? JSON.parse(ticket.context || '{}') : (ticket.context || {});
  const priority = context.priority || 'medium';

  return h('button', {
    onClick,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      width: '100%',
      padding: '12px 16px',
      background: selected ? colors.elevated : 'transparent',
      border: 'none',
      borderBottom: `1px solid ${colors.border}`,
      cursor: 'pointer',
      textAlign: 'left',
    },
  },
    // ID
    h('span', { style: { color: colors.textMuted, fontSize: 11, fontFamily: fonts.mono, minWidth: 60 } },
      `DP-${String(ticket.id).padStart(4, '0')}`
    ),
    // Type chip
    h(StatusChip, { type: ticket.type }),
    // Title
    h('span', {
      style: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: 13,
        fontFamily: fonts.body,
        fontWeight: 500,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
    }, ticket.title),
    // Priority dot
    h('span', {
      style: {
        width: 6, height: 6, borderRadius: '50%',
        backgroundColor: priorityColors[priority] || colors.warning,
      },
    }),
    // Date
    h('span', { style: { color: colors.textDim, fontSize: 11, fontFamily: fonts.mono, minWidth: 70, textAlign: 'right' } },
      new Date(ticket.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })
    ),
  );
}
```

- [ ] **Step 2: Create ticket-detail.js**

```js
// src/dashboard/components/ticket-detail.js
import { createElement as h, useState } from 'react';
import { colors, fonts, radii, spacing } from '../theme.js';
import { StatusChip } from './status-chip.js';

function InfoRow({ label, value }) {
  return h('div', { style: { display: 'flex', gap: 8 } },
    h('span', { style: { color: colors.textMuted, fontSize: 12, fontFamily: fonts.body, minWidth: 80 } }, label),
    h('span', { style: { color: colors.textSecondary, fontSize: 12, fontFamily: fonts.mono } }, value),
  );
}

function ActionButton({ label, color, variant, onClick, disabled }) {
  const isFilled = variant === 'filled';
  return h('button', {
    onClick,
    disabled,
    style: {
      padding: '8px 20px',
      borderRadius: radii.md,
      border: isFilled ? 'none' : `1px solid ${colors.border}`,
      backgroundColor: isFilled ? color : 'transparent',
      color: isFilled ? colors.bg : colors.textSecondary,
      fontFamily: fonts.body,
      fontWeight: 600,
      fontSize: 13,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    },
  }, label);
}

export function TicketDetail({ ticket, apiUrl, apiKey, onAction }) {
  const [rejecting, setRejecting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  if (!ticket) {
    return h('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: colors.textDim, fontFamily: fonts.mono, fontSize: 13,
      },
    }, 'Select a ticket to view details');
  }

  const context = typeof ticket.context === 'string' ? JSON.parse(ticket.context || '{}') : (ticket.context || {});

  async function handlePublish() {
    setPublishing(true);
    try {
      const res = await fetch(`${apiUrl}/api/tickets/${ticket.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onAction?.('published', ticket.id, data);
    } catch (err) {
      alert('Publish failed: ' + err.message);
    } finally {
      setPublishing(false);
    }
  }

  async function handleReject() {
    setRejecting(true);
    try {
      const res = await fetch(`${apiUrl}/api/tickets/${ticket.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ reason: rejectReason || 'Not applicable' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onAction?.('rejected', ticket.id, data);
    } catch (err) {
      alert('Reject failed: ' + err.message);
    } finally {
      setRejecting(false);
    }
  }

  const isPending = ticket.status === 'pending';

  return h('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: 18,
      padding: spacing.lg, overflowY: 'auto', height: '100%',
    },
  },
    // Title
    h('h2', { style: { color: colors.textPrimary, fontSize: 20, fontFamily: fonts.headline, fontWeight: 700 } }, ticket.title),
    // ID + Status
    h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
      h('span', { style: { color: colors.textMuted, fontSize: 12, fontFamily: fonts.mono } }, `DP-${String(ticket.id).padStart(4, '0')}`),
      h(StatusChip, { type: ticket.type }),
      h(StatusChip, { type: ticket.status, label: ticket.status }),
    ),
    // Separator
    h('div', { style: { height: 1, backgroundColor: colors.border } }),
    // Description
    h('div', { style: { color: colors.textSecondary, fontSize: 14, fontFamily: fonts.body, lineHeight: '1.6', whiteSpace: 'pre-wrap' } }, ticket.description),
    // Screenshot
    ticket.has_screenshot && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      h('span', { style: { color: colors.textMuted, fontSize: 12, fontFamily: fonts.mono } }, 'Screenshot'),
      h('img', {
        src: `${apiUrl}/api/tickets/${ticket.id}/screenshot?api_key=${apiKey}`,
        style: { maxWidth: '100%', borderRadius: radii.lg, border: `1px solid ${colors.border}` },
      }),
    ),
    // System info
    context.userAgent && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
      h('span', { style: { color: colors.textMuted, fontSize: 12, fontFamily: fonts.mono } }, 'System Info'),
      h('div', { style: { backgroundColor: colors.elevated, borderRadius: radii.md, padding: 12, display: 'flex', flexDirection: 'column', gap: 4 } },
        context.url && h(InfoRow, { label: 'URL', value: context.url }),
        context.userAgent && h(InfoRow, { label: 'User Agent', value: context.userAgent }),
        context.viewport && h(InfoRow, { label: 'Viewport', value: context.viewport }),
      ),
    ),
    // Actions
    isPending && h('div', { style: { display: 'flex', gap: 12, marginTop: 8 } },
      h(ActionButton, { label: publishing ? 'Publishing...' : 'Publish to GitHub', color: colors.success, variant: 'filled', onClick: handlePublish, disabled: publishing || rejecting }),
      h(ActionButton, { label: 'Reject', onClick: handleReject, disabled: publishing || rejecting }),
    ),
    // GitHub link if published
    ticket.github_issue_url && h('a', {
      href: ticket.github_issue_url,
      target: '_blank',
      rel: 'noopener',
      style: { color: colors.success, fontSize: 12, fontFamily: fonts.mono, textDecoration: 'none' },
    }, `→ GitHub Issue #${ticket.github_issue_number}`),
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/ticket-row.js src/dashboard/components/ticket-detail.js
git commit -m "feat(dashboard): add TicketRow and TicketDetail components"
```

---

### Task 12: ActivityRow Component

**Files:**
- Create: `src/dashboard/components/activity-row.js`

- [ ] **Step 1: Create activity-row.js**

```js
// src/dashboard/components/activity-row.js
import { createElement as h } from 'react';
import { colors, fonts } from '../theme.js';
import { StatusChip } from './status-chip.js';

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ActivityRow({ activity }) {
  return h('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 0',
      borderBottom: `1px solid ${colors.elevated}`,
    },
  },
    h(StatusChip, { type: activity.action }),
    h('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 } },
      h('span', { style: { color: colors.textPrimary, fontSize: 13, fontFamily: fonts.body, fontWeight: 500 } }, activity.action),
      h('span', { style: { color: colors.textSecondary, fontSize: 11, fontFamily: fonts.mono } }, activity.detail || `Ticket #${activity.ticket_id}`),
    ),
    h('span', { style: { color: colors.textMuted, fontSize: 11, fontFamily: fonts.mono } }, timeAgo(activity.created_at)),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/components/activity-row.js
git commit -m "feat(dashboard): add ActivityRow component"
```

---

### Task 13: InboxView

**Files:**
- Create: `src/dashboard/views/inbox-view.js`

- [ ] **Step 1: Create inbox-view.js**

```js
// src/dashboard/views/inbox-view.js
import { createElement as h, useState, useEffect } from 'react';
import { colors, fonts } from '../theme.js';
import { TicketRow } from '../components/ticket-row.js';
import { TicketDetail } from '../components/ticket-detail.js';

export function InboxView({ apiUrl, apiKey, filter, refreshKey }) {
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [loading, setLoading] = useState(true);

  // Fetch ticket list
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter === 'pending') params.set('status', 'pending');
    fetch(`${apiUrl}/api/tickets?${params}`, { headers: { 'X-API-Key': apiKey } })
      .then(r => r.json())
      .then(data => {
        let list = Array.isArray(data) ? data : (data.tickets || []);
        if (filter === 'bug' || filter === 'feature') {
          list = list.filter(t => t.type === filter);
        }
        setTickets(list);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [apiUrl, apiKey, filter, refreshKey]);

  // Fetch selected ticket detail
  useEffect(() => {
    if (!selectedId) { setSelectedTicket(null); return; }
    fetch(`${apiUrl}/api/tickets/${selectedId}`, { headers: { 'X-API-Key': apiKey } })
      .then(r => r.json())
      .then(setSelectedTicket)
      .catch(() => setSelectedTicket(null));
  }, [selectedId, apiUrl, apiKey, refreshKey]);

  function handleAction(action, ticketId) {
    // Update local state immediately
    setTickets(prev => prev.map(t =>
      t.id === ticketId ? { ...t, status: action === 'published' ? 'published' : 'rejected' } : t
    ));
    setSelectedTicket(prev => prev ? { ...prev, status: action === 'published' ? 'published' : 'rejected' } : null);
  }

  return h('div', { style: { display: 'flex', flex: 1, overflow: 'hidden' } },
    // Left: Ticket List
    h('div', {
      style: {
        width: 480,
        borderRight: `1px solid ${colors.border}`,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
      },
    },
      loading
        ? h('div', { style: { padding: 24, color: colors.textDim, fontFamily: fonts.mono, fontSize: 12 } }, 'Loading...')
        : tickets.length === 0
          ? h('div', { style: { padding: 24, color: colors.textDim, fontFamily: fonts.mono, fontSize: 12 } }, 'No tickets')
          : tickets.map(t =>
              h(TicketRow, {
                key: t.id,
                ticket: t,
                selected: t.id === selectedId,
                onClick: () => setSelectedId(t.id),
              })
            ),
    ),
    // Right: Ticket Detail
    h('div', { style: { flex: 1, overflow: 'hidden' } },
      h(TicketDetail, { ticket: selectedTicket, apiUrl, apiKey, onAction: handleAction }),
    ),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/views/inbox-view.js
git commit -m "feat(dashboard): add InboxView with split pane"
```

---

### Task 14: DashboardView

**Files:**
- Create: `src/dashboard/views/dashboard-view.js`

- [ ] **Step 1: Create dashboard-view.js**

```js
// src/dashboard/views/dashboard-view.js
import { createElement as h, useState, useEffect } from 'react';
import { colors, fonts, radii, spacing } from '../theme.js';
import { MetricCard } from '../components/metric-card.js';
import { ActivityRow } from '../components/activity-row.js';

function ProjectRow({ name, tickets, status }) {
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 0', borderBottom: `1px solid ${colors.elevated}`,
    },
  },
    h('span', {
      style: { width: 8, height: 8, borderRadius: '50%', backgroundColor: status === 'active' ? colors.success : colors.warning },
    }),
    h('span', { style: { flex: 1, color: colors.textPrimary, fontSize: 13, fontFamily: fonts.mono, fontWeight: 500 } }, name),
    h('span', { style: { color: colors.textMuted, fontSize: 11, fontFamily: fonts.mono } }, `${tickets} tickets`),
  );
}

export function DashboardView({ apiUrl, apiKey, activities, refreshKey }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    fetch(`${apiUrl}/api/stats`, { headers: { 'X-API-Key': apiKey } })
      .then(r => r.json())
      .then(setStats)
      .catch(() => {});
  }, [apiUrl, apiKey, refreshKey]);

  const s = stats?.stats || {};
  const total = s.total || 0;
  const bugs = s.pending || 0; // approximate open bugs
  const features = 0; // stats endpoint doesn't split by type yet
  const published = s.published || 0;

  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 20, padding: spacing.lg, overflowY: 'auto', flex: 1 } },
    // Metric Cards
    h('div', { style: { display: 'flex', gap: 16 } },
      h(MetricCard, { label: 'Total Tickets', value: String(total), delta: 'all time', accentColor: colors.info }),
      h(MetricCard, { label: 'Pending', value: String(s.pending || 0), delta: 'to review', accentColor: colors.warning }),
      h(MetricCard, { label: 'Published', value: String(published), delta: 'on GitHub', accentColor: colors.success }),
      h(MetricCard, { label: 'Rejected', value: String(s.rejected || 0), delta: 'closed', accentColor: colors.error }),
    ),
    // Content split
    h('div', { style: { display: 'flex', gap: 20, flex: 1, overflow: 'hidden' } },
      // Left: Activity Feed
      h('div', {
        style: {
          flex: 3, backgroundColor: colors.card, borderRadius: radii.lg,
          padding: '18px 20px', display: 'flex', flexDirection: 'column', overflowY: 'auto',
        },
      },
        h('h3', { style: { color: colors.textPrimary, fontSize: 16, fontFamily: fonts.headline, fontWeight: 600, marginBottom: 12 } }, 'Recent Activity'),
        activities.length === 0
          ? h('span', { style: { color: colors.textDim, fontSize: 12, fontFamily: fonts.mono } }, 'No activity yet')
          : activities.map((a, i) => h(ActivityRow, { key: a.id || i, activity: a })),
      ),
      // Right column
      h('div', { style: { flex: 2, display: 'flex', flexDirection: 'column', gap: 20 } },
        // Projects
        h('div', {
          style: {
            backgroundColor: colors.card, borderRadius: radii.lg,
            padding: '18px 20px', display: 'flex', flexDirection: 'column',
          },
        },
          h('h3', { style: { color: colors.textPrimary, fontSize: 16, fontFamily: fonts.headline, fontWeight: 600, marginBottom: 12 } }, 'Projects'),
          h(ProjectRow, { name: stats?.project || 'dev-panel', tickets: total, status: 'active' }),
        ),
        // GitHub Sync
        h('div', {
          style: {
            backgroundColor: colors.card, borderRadius: radii.lg,
            padding: '18px 20px', flex: 1, display: 'flex', flexDirection: 'column', gap: 12,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('h3', { style: { flex: 1, color: colors.textPrimary, fontSize: 16, fontFamily: fonts.headline, fontWeight: 600 } }, 'GitHub Sync'),
            h('span', {
              style: {
                padding: '2px 8px', borderRadius: radii.sm,
                backgroundColor: colors.success + '26', color: colors.success,
                fontSize: 10, fontFamily: fonts.mono, fontWeight: 700,
              },
            }, '● Connected'),
          ),
          // Stats row
          h('div', {
            style: {
              display: 'flex', justifyContent: 'space-around',
              backgroundColor: colors.elevated, borderRadius: radii.md, padding: 12,
            },
          },
            ...[
              { label: 'Published', value: String(published) },
              { label: 'Pending', value: String(s.pending || 0) },
            ].map(item =>
              h('div', { key: item.label, style: { textAlign: 'center' } },
                h('div', { style: { color: colors.textPrimary, fontSize: 20, fontFamily: fonts.headline, fontWeight: 700 } }, item.value),
                h('div', { style: { color: colors.textMuted, fontSize: 10, fontFamily: fonts.mono } }, item.label),
              )
            ),
          ),
        ),
      ),
    ),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/views/dashboard-view.js
git commit -m "feat(dashboard): add DashboardView with metrics and activity"
```

---

### Task 15: SettingsView

**Files:**
- Create: `src/dashboard/views/settings-view.js`

- [ ] **Step 1: Create settings-view.js**

```js
// src/dashboard/views/settings-view.js
import { createElement as h, useState } from 'react';
import { colors, fonts, radii, spacing } from '../theme.js';

function NavItem({ label, active, danger, onClick }) {
  return h('button', {
    onClick,
    style: {
      display: 'block', width: '100%', textAlign: 'left',
      padding: '8px 12px', borderRadius: radii.md,
      backgroundColor: active ? colors.elevated : 'transparent',
      border: 'none', cursor: 'pointer',
      color: danger ? (colors.error + 'B3') : (active ? colors.textPrimary : colors.textSecondary),
      fontFamily: fonts.body, fontSize: 13, fontWeight: active ? 500 : 400,
    },
  }, label);
}

function FieldDisplay({ label, value }) {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    h('span', { style: { color: colors.textSecondary, fontSize: 12, fontFamily: fonts.body, fontWeight: 500 } }, label),
    h('div', {
      style: {
        padding: '8px 12px', backgroundColor: colors.elevated, borderRadius: radii.md,
        border: `1px solid ${colors.border}`,
        color: colors.textPrimary, fontSize: 13, fontFamily: fonts.mono,
      },
    }, value || '—'),
  );
}

export function SettingsView({ apiUrl, apiKey }) {
  const [section, setSection] = useState('project');

  const sections = [
    { id: 'project', label: 'Project' },
    { id: 'github', label: 'GitHub' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'storage', label: 'Storage' },
    { id: 'danger', label: 'Danger Zone', danger: true },
  ];

  return h('div', { style: { display: 'flex', flex: 1, overflow: 'hidden' } },
    // Left nav
    h('div', {
      style: {
        width: 220, backgroundColor: colors.card, borderRadius: radii.lg,
        margin: `${spacing.lg}px 0 ${spacing.lg}px ${spacing.lg}px`,
        padding: '16px 8px', display: 'flex', flexDirection: 'column', gap: 2,
      },
    },
      sections.map(s => h(NavItem, {
        key: s.id, label: s.label, active: section === s.id,
        danger: s.danger, onClick: () => setSection(s.id),
      })),
    ),
    // Right content
    h('div', {
      style: {
        flex: 1, padding: spacing.lg, overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 24,
      },
    },
      h('h2', { style: { color: colors.textPrimary, fontSize: 22, fontFamily: fonts.headline, fontWeight: 700 } },
        sections.find(s => s.id === section)?.label + ' Settings'
      ),
      h('p', { style: { color: colors.textMuted, fontSize: 13, fontFamily: fonts.body } },
        'Configuration is read-only. Edit .devpanelrc.json or use the CLI.'
      ),
      section === 'project' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 600 } },
        h(FieldDisplay, { label: 'API URL', value: apiUrl }),
        h(FieldDisplay, { label: 'API Key', value: apiKey ? apiKey.slice(0, 8) + '...' : '—' }),
      ),
      section === 'github' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 600 } },
        h(FieldDisplay, { label: 'Repository', value: 'Configure in .devpanelrc.json' }),
        h(FieldDisplay, { label: 'Token', value: 'Set via GITHUB_TOKEN env var' }),
      ),
      section === 'storage' && h('div', { style: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 600 } },
        h(FieldDisplay, { label: 'Storage Path', value: './storage' }),
        h(FieldDisplay, { label: 'Max File Size', value: '10MB' }),
      ),
    ),
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/views/settings-view.js
git commit -m "feat(dashboard): add SettingsView"
```

---

### Task 16: App.js — Root Orchestrator

**Files:**
- Create: `src/dashboard/app.js`

- [ ] **Step 1: Create app.js**

```js
// src/dashboard/app.js
import { createElement as h, useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { colors } from './theme.js';
import { TabBar } from './components/tab-bar.js';
import { CommandDock } from './components/command-dock.js';
import { InboxView } from './views/inbox-view.js';
import { DashboardView } from './views/dashboard-view.js';
import { SettingsView } from './views/settings-view.js';

function App() {
  const [activeTab, setActiveTab] = useState('inbox');
  const [filter, setFilter] = useState(null);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('devpanel_api_key') || '');
  const [sseConnected, setSseConnected] = useState(false);
  const [activities, setActivities] = useState([]);
  const [stats, setStats] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const sseRef = useRef(null);

  const apiUrl = window.location.origin;

  // Prompt for API key if not set
  useEffect(() => {
    if (!apiKey) {
      const key = prompt('Enter your DevPanel API key:');
      if (key) {
        localStorage.setItem('devpanel_api_key', key);
        setApiKey(key);
      }
    }
  }, []);

  // Fetch initial activity
  useEffect(() => {
    if (!apiKey) return;
    fetch(`${apiUrl}/api/activity`, { headers: { 'X-API-Key': apiKey } })
      .then(r => r.ok ? r.json() : [])
      .then(setActivities)
      .catch(() => {});
  }, [apiKey, apiUrl]);

  // Fetch stats for tab bar badges
  useEffect(() => {
    if (!apiKey) return;
    fetch(`${apiUrl}/api/stats`, { headers: { 'X-API-Key': apiKey } })
      .then(r => r.ok ? r.json() : null)
      .then(setStats)
      .catch(() => {});
  }, [apiKey, apiUrl, refreshKey]);

  // SSE connection
  useEffect(() => {
    if (!apiKey) return;

    function connect() {
      const es = new EventSource(`${apiUrl}/api/events?api_key=${apiKey}`);
      sseRef.current = es;

      es.onopen = () => setSseConnected(true);
      es.onerror = () => {
        setSseConnected(false);
        es.close();
        // Reconnect after 5s
        setTimeout(connect, 5000);
      };

      es.addEventListener('ticket:created', (e) => {
        const data = JSON.parse(e.data);
        setActivities(prev => [{ action: 'created', detail: `${data.type}: ${data.title}`, ticket_id: data.id, created_at: new Date().toISOString() }, ...prev.slice(0, 49)]);
        setRefreshKey(k => k + 1);
      });

      es.addEventListener('ticket:published', (e) => {
        const data = JSON.parse(e.data);
        setActivities(prev => [{ action: 'published', detail: `→ GitHub issue #${data.issueNumber}`, ticket_id: data.id, created_at: new Date().toISOString() }, ...prev.slice(0, 49)]);
        setRefreshKey(k => k + 1);
      });

      es.addEventListener('ticket:updated', (e) => {
        const data = JSON.parse(e.data);
        setActivities(prev => [{ action: data.status || 'updated', detail: `Ticket #${data.id}`, ticket_id: data.id, created_at: new Date().toISOString() }, ...prev.slice(0, 49)]);
        setRefreshKey(k => k + 1);
      });
    }

    connect();
    return () => { sseRef.current?.close(); };
  }, [apiKey, apiUrl]);

  if (!apiKey) {
    return h('div', {
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', color: colors.textMuted, fontFamily: "'IBM Plex Mono', monospace",
      },
    }, 'API key required. Refresh to try again.');
  }

  const tabStats = stats?.stats ? {
    pending: stats.stats.pending,
    bugs: 0, // could be computed if API returns type breakdown
    features: 0,
  } : {};

  return h('div', {
    style: {
      display: 'flex', flexDirection: 'column',
      height: '100vh', backgroundColor: colors.bg,
    },
  },
    h(TabBar, { activeTab, onTabChange: setActiveTab, stats: tabStats, activeFilter: filter, onFilterChange: setFilter }),
    // Main content
    activeTab === 'inbox' && h(InboxView, { apiUrl, apiKey, filter, refreshKey }),
    activeTab === 'dashboard' && h(DashboardView, { apiUrl, apiKey, activities, refreshKey }),
    activeTab === 'settings' && h(SettingsView, { apiUrl, apiKey }),
    h(CommandDock, {
      projectName: stats?.project,
      sseConnected,
      ticketCount: stats?.stats?.total,
    }),
  );
}

// Mount
const root = createRoot(document.getElementById('root'));
root.render(h(App));
```

- [ ] **Step 2: Commit**

```bash
git add src/dashboard/app.js
git commit -m "feat(dashboard): add App orchestrator with SSE and tab routing"
```

---

### Task 17: Integration — Wire Everything Together

**Files:**
- Verify all files exist and server starts

- [ ] **Step 1: Start server and test dashboard loads**

```bash
node bin/dev-panel.js serve
```

Open `http://localhost:3030/dashboard` in browser. Verify:
- HTML loads with React from esm.sh
- API key prompt appears
- After entering key, Inbox tab shows

- [ ] **Step 2: Test SSE connection**

Open browser DevTools Network tab, filter EventStream. Verify `/api/events` connection is established and heartbeat pings arrive.

- [ ] **Step 3: Test ticket list loads**

Verify tickets appear in Inbox left pane. Click a ticket to see detail on right pane.

- [ ] **Step 4: Test publish/reject actions**

Select a pending ticket, click "Publish to GitHub" or "Reject". Verify SSE event arrives and UI updates.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(dashboard): integration fixes from manual testing"
```
