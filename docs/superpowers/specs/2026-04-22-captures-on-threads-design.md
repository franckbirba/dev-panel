# Captures on the generic thread model

**Status:** approved, ready for implementation plan
**Author:** Claude (with Franck)
**Date:** 2026-04-22
**Related:** [2026-04-21 signal-inbox redesign](./2026-04-21-signal-inbox-redesign-design.md) — this spec completes a slice of that plan.

## Problem

Today, capture conversations live in their own tables (`captures` + `capture_messages`) and are only reachable through `/api/captures/*`. When Franck posts a reply from the dashboard's Inbox view (e.g. "do you see this bug shelly?"), the row is saved locally but **nothing is pushed to Telegram**. Shelly only polls Telegram — she never hears the message. Result: she looks broken.

Contrast with the subject/thread model (`subjects` + `threads` + `thread_messages`) used for work items, PRs, deploys, jobs, etc. — `POST /api/threads/:subject_type/:subject_id/messages` already forwards to Telegram with a `[thread:<type>/<id>]` tag, and Shelly's persona already knows to reply with the same tag.

`subjects.js` already lists `'capture'` as a valid `subject_type`. The plumbing exists; captures just never migrated onto it.

## Goal

Converge capture conversations onto `subjects` + `threads` + `thread_messages`. Dashboard replies push to Telegram. Shelly replies back through the same tag protocol she uses everywhere else. Kill `capture_messages`. Keep the `captures` table for lifecycle state only (`status`, `kind`, `plane_work_item_id`, `plane_sequence_id`).

## Non-goals (parked)

- **Thread re-pointing on promotion** — when a capture becomes a Plane work item, the thread keeps its `(capture, <cap_id>)` key. `captures-view.jsx` already shows a `→ DEVPA-42` tag; that's enough continuity for now. The April 21 spec describes the re-pointing; revisit when it's needed for the signals feed.
- **Moving captures into the unified signals feed** — `captures-view.jsx` stays as a dedicated view. Deleting it is part of the signal-inbox redesign (Stage 3 of the Apr 21 spec), not this PR.
- **Changing capture creation from Telegram** — today captures are only created from the dashboard. No change.

## Design

### Data model

No schema change. `subjects`, `threads`, `thread_messages` already exist and already accept `subject_type='capture'`. The `role` whitelist on `thread_messages` (`user | shelly | system | agent`) is a superset of the roles `capture_messages` uses (`user | shelly | system`).

### Migration

One-time, idempotent, on server boot. Guarded by a `PRAGMA user_version` bump: the migration runs only when the current version is below the target.

Steps:

1. For each row in `captures`:
   `INSERT OR IGNORE INTO subjects (subject_type, subject_id, project_id, title) VALUES ('capture', id, project_id, substr(content, 1, 120))`.
2. For each row in `captures`:
   `INSERT OR IGNORE INTO threads (subject_type, subject_id, project_id) VALUES ('capture', id, project_id)`. The existing `UNIQUE(subject_type, subject_id)` makes this safe.
3. For each row in `capture_messages` (ordered by `id`):
   `INSERT INTO thread_messages (thread_id, role, source, content, created_at) SELECT t.thread_id, cm.role, 'web', cm.content, cm.created_at FROM capture_messages cm JOIN threads t ON t.subject_type='capture' AND t.subject_id=cm.capture_id`.
   `source='web'` is the honest default — today all `capture_messages` rows come from the dashboard; none come from Telegram.
4. `DROP TABLE capture_messages`.
5. Bump `PRAGMA user_version`. Subsequent boots see the new version and skip the migration entirely.

All five steps run in one SQLite transaction. If any step fails, the whole thing rolls back and the server errors at boot — we fail loudly rather than boot half-migrated. If a rollback ever becomes necessary, data is recoverable from a SQLite backup + git history of `db.js`.

### Server — endpoints

**Remove:**
- `POST /api/captures/:id/messages` — delete. No external callers; `captures-view.jsx` will call the thread endpoint instead.
- `addCaptureMessage()` helper in `captures.js` — delete.

**Rewrite:**
- `GET /api/captures/:id` — same URL, new implementation. Returns the capture row + its `messages[]` by joining through `threads` / `thread_messages` for `(subject_type='capture', subject_id=<id>)`. Preserves the existing response shape so the dashboard doesn't need reshaping.
- `GET /api/captures` (list) — already returns `message_count` / `last_message` / `last_role`. Rewrite those subselects to query `thread_messages` joined via `threads`.
- `createCapture()` in `captures.js` — on insert, also `INSERT` the subject, the thread, and the first `thread_messages` row with `role='user', source='web'`. Keep all four writes in one transaction. No more writes to `capture_messages` — the table is gone.

**Unchanged:**
- `POST /api/captures` (create) — still accepts `{content, kind}` and returns a capture.
- `PATCH /api/captures/:id` — status / plane_* updates.
- `DELETE /api/captures/:id` — `subjects` and `threads` FKs only cascade from `projects`, not from `captures`. So deleting a capture won't clean up its subject or thread automatically. Add explicit cleanup in `deleteCapture()`: `DELETE FROM threads WHERE subject_type='capture' AND subject_id=?` (cascades to `thread_messages`) and `DELETE FROM subjects WHERE subject_type='capture' AND subject_id=?`, all in the same transaction as the capture delete.

### Dashboard — `captures-view.jsx`

Two call sites change:

1. `handleReply()` — currently `POST /api/captures/:id/messages`. Replace with `POST /api/threads/capture/:id/messages`. Same request body shape; the threads endpoint already handles Telegram forwarding + SSE broadcast + DB write.
2. `loadThread()` — still hits `GET /api/captures/:id`. No change needed on the client: the server rewrite preserves the response shape (`{...capture, messages: [...]}`).

Optionally (not required for this PR): subscribe to the existing `thread:message` SSE event to drop the 8-second poll. Leave for a follow-up — polling still works.

### Shelly — SOUL + MCP

- **SOUL** — append a line to the `.agents/shelly/SOUL.md` "Captures" section: _"When you reply to a capture, use `[thread:capture/<id>]` as the tag and post via `POST /api/threads/capture/<id>/messages` OR call the `thread_append` MCP with the prefixed message. The old `POST /api/captures/:id/messages` is gone."_ This keeps the capture-specific triage rules (ask max 2 questions, promote or drop) but swaps the transport.
- **MCP `thread_append`** — already handles `[thread:capture/<id>]` because the parser is generic over subject types. No change.

### Telegram forwarding

Existing behavior on `/api/threads/*/messages` applies verbatim to captures:
- `SHELLY_TELEGRAM_WEBHOOK` (preferred) or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (fallback).
- `source='web'` messages tagged with `[thread:capture/<id>]` when forwarded.
- Inbound `[thread:capture/<id>]` from Shelly writes `source='telegram'` via `appendFromTelegram()`, dedup'd on `telegram_message_id`.

### Signals feed

`signals.js` reads from `captures` + `capture_messages`. Update the capture-producing query to join `thread_messages` instead of `capture_messages` for `last_role`. Small edit.

## Error handling

- Backfill runs inside a single SQLite transaction. If any step fails, roll back and let the server error at boot — we'd rather fail loudly than boot half-migrated.
- `DROP TABLE capture_messages` happens in the same transaction as the backfill. Either the whole migration lands or none of it does.
- Telegram forwarding is fire-and-forget (same pattern as threads today). A network failure does not block the reply from being saved locally.

## Testing

- Unit test the backfill: seed `captures` + `capture_messages` rows, run boot migration, assert `thread_messages` rows match 1:1 with `source='web'`, assert `capture_messages` table gone, assert second boot is a no-op.
- Integration: `POST /api/captures` creates a capture; `GET /api/captures/:id` returns it with the seeded first message; `POST /api/threads/capture/:id/messages` appends a user reply; `GET /api/captures/:id` reflects the new message; SSE `thread:message` fires.
- Manual: push to prod (CI deploys `devpanel` container only — services survive). Open dashboard, create a capture, post a reply. Telegram receives `[thread:capture/<id>] <content>`. Shelly replies. Dashboard shows it.

## Rollout

- One PR, one deploy. CI already limits deploys to the `devpanel` container, so the services stack is unaffected.
- Migration is idempotent; rollback means reverting the code — the data has already moved. No downgrade path for `capture_messages`. Acceptable given prod has run a few days with a handful of messages.
