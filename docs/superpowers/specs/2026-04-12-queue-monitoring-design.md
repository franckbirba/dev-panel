# Queue Monitoring for DevPanel

**Date:** 2026-04-12
**Status:** Approved

## Goal

Add BullMQ job monitoring to the DevPanel dashboard: a summary widget in the existing Dashboard tab and a dedicated `/queues` page for full queue/job management.

## Architecture Overview

Two UI surfaces, one backend layer:

1. **Queue Summary Widget** — embedded in Dashboard tab, read-only, real-time via SSE
2. **Queues Page (`/queues`)** — standalone React view, full job listing + admin actions
3. **Backend** — new REST endpoints + SSE channel, auth split (read = project, actions = admin)

## 1. Queue Summary Widget (Dashboard Tab)

Location: below metric cards in `src/dashboard/views/dashboard-view.jsx`

Displays all 4 queues (`devpanel:tickets`, `devpanel:github_sync`, `devpanel:notifications`, `devpanel:dead_letter`) as compact cards:

- Queue name + status chip (healthy / warning / critical)
- Counters: waiting / active / delayed / failed
- Link "Open full view" pointing to `/queues`

Data source: SSE event `queue:update` pushed by server every 5s (only on change).

## 2. Queues Page (`/queues`)

Full-screen React view in the same Vite dashboard app.

### Layout

- Header: title "Queue Monitor" + back link to `/` + SSE connection indicator
- 4 queue cards in grid (same data as summary, plus actions)
- Detail panel below: appears when a queue card is clicked

### Queue Card

- Name + status chip
- Counters: waiting / active / delayed / failed / completed
- Admin actions: Pause/Resume, Clean completed

### Detail Panel

- Tabs by job state: Waiting | Active | Delayed | Failed | Completed
- Job list: ID, name, timestamps, attempts, progress
- Click a job -> side panel with:
  - Full JSON data
  - Stacktrace (if failed)
  - Attempts timeline
- Per-job actions: Retry (failed), Remove, Promote (delayed)

### Routing

Add `wouter` (~1.5KB) as dependency:
- `<Route path="/">` renders current dashboard
- `<Route path="/queues">` renders `QueuesView`
- Navigation via `<Link>` components

## 3. Backend — New Endpoints

### Read endpoints (project auth via `X-API-Key`)

| Route | Description |
|---|---|
| `GET /api/queues` | Counters for all queues |
| `GET /api/queues/:name/jobs` | Job list, filtered by `?status=failed&start=0&limit=50` |
| `GET /api/queues/:name/jobs/:id` | Job detail (data, stacktrace, attempts) |

### Action endpoints (admin auth via `X-Admin-Key`)

| Route | Description |
|---|---|
| `POST /api/queues/:name/pause` | Pause a queue |
| `POST /api/queues/:name/resume` | Resume a queue |
| `POST /api/queues/:name/clean` | Purge completed/failed jobs |
| `POST /api/queues/:name/jobs/:id/retry` | Retry a failed job |
| `DELETE /api/queues/:name/jobs/:id` | Remove a job |
| `POST /api/queues/:name/jobs/:id/promote` | Promote a delayed job |

### Queue name validation

The `:name` parameter is validated against the `QUEUES` map in `src/server/bullmq.js`. Unknown names return 404.

### SSE — `queue:update` event

Server-side `setInterval` (5s) calls `getAllQueuesHealth()` and broadcasts via existing `src/server/sse.js`. Only sends when counters differ from last broadcast (diff check).

## 4. Error Handling

- **Redis unavailable**: endpoints return `503 { error: "Redis unavailable" }`. Widget shows "disconnected" state. SSE sends `{ status: "unreachable" }`.
- **Empty queues**: all counters at 0, status "healthy" — normal state.
- **Admin key in dev**: same as existing — actions allowed without key in dev, blocked in prod.
- **Large job data**: list endpoint truncates `data` field to 1KB. Detail endpoint returns full data.
- **Stacktraces**: returned as-is for debugging.

## 5. New Files

| File | Role |
|---|---|
| `src/dashboard/views/queues-view.jsx` | Standalone `/queues` page |
| `src/dashboard/components/queue-card.jsx` | Queue summary card (counters, status, actions) |
| `src/dashboard/components/queue-summary.jsx` | Widget block for Dashboard tab (4 cards + link) |
| `src/dashboard/components/job-list.jsx` | Job list with state tabs and pagination |
| `src/dashboard/components/job-detail.jsx` | Side panel: job data, stacktrace, timeline |

## 6. Existing Files Modified

| File | Changes |
|---|---|
| `src/dashboard/app.jsx` | Add wouter routing, `/queues` route |
| `src/dashboard/views/dashboard-view.jsx` | Add `QueueSummary` widget below metrics |
| `src/server/routes.js` | Add 9 new queue endpoints |
| `src/server/index.js` | Add SSE queue update interval |
| `package.json` | Add `wouter` dependency |

## 7. Reused Existing Components

- `status-chip.jsx` — healthy/warning/critical states
- `badge.jsx` — counter badges
- `card.jsx` — queue cards
- `tabs.jsx` — job state tabs
- `scroll-area.jsx` — job list scrolling

## Dependencies

- `wouter` — lightweight React router (~1.5KB)
- No Bull Board or other external queue UI
