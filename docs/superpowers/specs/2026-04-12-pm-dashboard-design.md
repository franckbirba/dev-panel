# PM Dashboard — Design Spec

## Overview

Web-based PM dashboard served by the existing Express server at `/dashboard`. Replaces CLI commands (`list`, `review`, `publish`, `reject`) with a React SPA using the Ink & Wire design system from Penpot.

## Stack

- **Server:** Existing Express, new routes + SSE endpoint
- **Client:** React 19 via esm.sh CDN (no build step, pure ESM)
- **Style:** Inline styles, Ink & Wire palette
- **Real-time:** Server-Sent Events for live ticket updates

## API Routes (new)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/dashboard` | Serve SPA HTML shell |
| GET | `/dashboard/*` | Static assets (JS modules) |
| GET | `/api/stats` | Aggregated metrics (total, open bugs, features, published) |
| GET | `/api/activity` | Recent activity feed (last 50 events) |
| GET | `/api/events` | SSE stream (ticket:created, ticket:updated, ticket:published, sync:complete) |
| POST | `/api/tickets/:id/publish` | Publish ticket to GitHub issue |
| POST | `/api/tickets/:id/reject` | Reject a ticket |

Existing routes used: `GET /api/tickets`, `GET /api/tickets/:id`, `GET /api/tickets/:id/screenshot`

## Frontend Architecture

### File Structure

```
src/dashboard/
  index.html            # HTML shell with esm.sh import maps
  app.js                # Main App component, tab state, SSE
  theme.js              # Ink & Wire tokens (colors, fonts, spacing)
  views/
    inbox-view.js       # Split pane: ticket list + ticket detail
    dashboard-view.js   # Metrics cards + activity feed + projects + sync
    settings-view.js    # Project config (read-only from .devpanelrc.json)
  components/
    tab-bar.js          # Top nav: Inbox (badge), Dashboard, Settings + filters
    command-dock.js     # Bottom bar: context, command input, shortcuts, sync indicator
    ticket-row.js       # Single ticket in list (id, title, type chip, priority, date)
    ticket-detail.js    # Full ticket view (meta, description, screenshot, system info, actions)
    metric-card.js      # Stat card (label, value, delta, accent color)
    activity-row.js     # Activity feed item (chip, action, detail, time)
    status-chip.js      # Colored chip (bug/feature/published/rejected/pending)
```

All files use `.js` with HTM-style tagged templates or JSX pragma via esm.sh — no transpilation needed.

### Views

**Inbox (default tab)**
- Left pane (480px): scrollable ticket list, sorted by date desc
- Right pane (remaining): selected ticket detail with screenshot preview, system info, publish/reject actions
- Filters in tab bar: Bugs, Features, Pending (with counts)
- Clicking a ticket row selects it and shows detail

**Dashboard**
- 4 metric cards: Total Tickets, Open Bugs, Feature Requests, Published to GitHub
- Activity Feed (left, 60%): live-updating via SSE, 8+ recent events with type chips
- Projects panel (right top): list of registered projects with status dots
- GitHub Sync panel (right bottom): sync stats, last sync time, repo name, sync button

**Settings**
- Left nav: Project, GitHub, Notifications, Storage, Danger Zone
- Right content: form fields displaying current `.devpanelrc.json` values
- Read-only for now (edit via CLI), toggles shown but disabled
- Save/Reset buttons shown but inactive (future: direct config editing)

### SSE Events

Server emits JSON events on `GET /api/events`:

```
event: ticket:created
data: {"id": "abc123", "title": "...", "type": "bug"}

event: ticket:updated  
data: {"id": "abc123", "status": "published"}
```

Client: EventSource with auto-reconnect. On event, update React state (prepend to activity feed, refresh metrics, update ticket status in list).

### Design Tokens (Ink & Wire)

```js
colors: {
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
}
fonts: {
  headline: 'Epilogue',
  body: 'IBM Plex Sans',
  mono: 'IBM Plex Mono',
}
```

## Server Changes

### SSE Implementation

New module `src/server/sse.js`:
- Maintains Set of connected clients (res objects)
- `broadcast(event, data)` function called from ticket creation/update handlers
- Heartbeat every 30s to keep connections alive
- Cleanup on client disconnect

### Stats Endpoint

Queries SQLite for aggregated counts:
- Total tickets, open bugs, open features, published count
- Computed from existing `tickets` table columns (type, status)

### Activity Endpoint

New `activity_log` table in project DB:
- `id`, `action` (created/published/rejected/synced), `ticket_id`, `detail`, `timestamp`
- Populated by existing ticket operations (create, publish, reject, sync)
- Returns last 50 entries sorted by timestamp desc

### Publish/Reject Endpoints

Extract logic from existing CLI commands (`src/cli/commands/publish.js`, `src/cli/commands/reject.js`) into shared service functions in `src/server/services.js`, then call from both CLI and API routes.

## Auth

Same API key auth as existing routes (`X-API-Key` header). Dashboard HTML page served without auth (SPA handles auth client-side — API key stored in localStorage after first entry).

## Out of Scope

- Settings editing (read-only for v1)
- Multi-user / roles
- Mobile responsive
- Build tooling / bundling
