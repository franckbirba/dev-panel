# Database schema

DevPanel uses a two-tier SQLite layout. All migrations are gated by
`PRAGMA user_version` and live in `src/server/db.js`.

| Tier | File | Owner | Notes |
|---|---|---|---|
| Master | `storage/projects.db` | API server | Multi-project registry, captures, signal-inbox, widget sessions |
| Project | `storage/<project_id>/tickets.db` | API server, per project | Tickets, milestones, docs, activity |

## Master DB — migration history

| `user_version` | What changed |
|---|---|
| 1 | `capture_messages` rolled up into `thread_messages` (`source` defaulted to `'web'` for all backfilled rows) |
| 2 | `thread_messages.metadata` (TEXT) added for widget capture context |
| 3 | Reporter identity columns on `captures` (`reporter_id`, `reporter_name`, `reporter_email`, `reporter_extra`) |
| 4 | `captures.environment` (TEXT) tag |
| 5 | Capture routing columns (`routed_label`, `routed_member_id`, `routed_at`) |
| 6 | `inbox_state` table (per-subject snooze/dismiss/seen) |
| 7 | `widget_sessions` table; `captures.source` + `captures.widget_session_id`; canonicalised `thread_messages.source` from `'web'` to `'dashboard'` |

## Source taxonomy (canonical values)

`thread_messages.source` and `captures.source` use the same vocabulary:

| Value | Meaning |
|---|---|
| `dashboard` | Dashboard UI in `app.devpanl.dev` (replaces the legacy `'web'`) |
| `telegram` | Inbound from Telegram (Shelly or another paired bot) |
| `widget` | Embedded DevPanel widget in a customer-facing app |
| `agent` | Ephemeral coding agent (`claude -p` subprocess) |
| `shelly` | Shelly's own outbound message |

Migration v7 rewrites every existing `thread_messages.source = 'web'` row to
`'dashboard'`. Code paths still emitting `'web'` should be updated as part of
the widget API work (DEVPA-161).

## `widget_sessions`

One row per browser-tab conversation surfaced through the embedded widget.
Created by the widget API when the host app opens the chat surface; closed
when the user dismisses the widget or the session goes idle.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID minted by the widget API |
| `project_id` | TEXT NOT NULL | FK → `projects(id)` ON DELETE CASCADE |
| `session_token` | TEXT NOT NULL UNIQUE | Opaque token passed back by the widget on every request |
| `thread_id` | INTEGER | Bound to the subject `widget/<session_id>` thread (FK left unenforced — the thread is created lazily) |
| `user_agent` | TEXT | Browser UA captured at session start |
| `route` | TEXT | Path the user was on when they opened the widget |
| `viewport_w` | INTEGER | Viewport width in CSS pixels |
| `viewport_h` | INTEGER | Viewport height |
| `locale` | TEXT | `navigator.language` |
| `started_at` | DATETIME DEFAULT CURRENT_TIMESTAMP | |
| `last_seen_at` | DATETIME | Bumped on every widget heartbeat |
| `closed_at` | DATETIME | Set when the widget closes the session |

Indexes: `idx_widget_sessions_project`, `idx_widget_sessions_last_seen DESC`.

## `captures` (widget-related columns added in v7)

| Column | Type | Notes |
|---|---|---|
| `source` | TEXT NOT NULL DEFAULT `'dashboard'` | One of the canonical values above |
| `widget_session_id` | TEXT | FK → `widget_sessions(id)`, nullable for non-widget captures |

FK enforcement requires `PRAGMA foreign_keys = ON`; SQLite leaves it off by
default. Tests that need FK validation set the pragma on each connection.
