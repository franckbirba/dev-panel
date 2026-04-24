# Widget reporter identity

**Date:** 2026-04-24
**Status:** Approved design, ready for plan

## Problem

The `@devpanel/react` widget currently ships every capture anonymously. For
single-user apps (EDMS) that's fine because there's no ambiguity. For
multi-user apps (Zeno), it's a dead end: a ticket lands in the dashboard with
no way to tell who filed it, so triage has to guess or go ask.

## Goal

Let the host app hand the widget a user identity, carry it through to the
backend, persist it queryably, and surface it in the dashboard — without
breaking the existing EDMS integration that passes no user info.

## Non-goals

- No widget-side prompt ("who are you?"). Identity comes from the host app only.
- No signed user tokens or authentication of the reporter claim. The project
  API key already authenticates the widget; the host app is trusted to report
  its own user accurately. If the widget ever goes public, we revisit.
- No user table. Reporters are free-form strings, not FK'd to anything.

## Design

### 1. Widget API — `src/react/DevPanel.jsx`

New optional prop `user`:

```jsx
<DevPanel
  apiKey="dp_..."
  user={{ id: 'u_42', name: 'Alice Cooper', email: 'alice@zeno.com', role: 'pm' }}
/>
```

- Flexible object: `id`, `name`, `email` are the understood fields; any extra
  fields are kept and forwarded.
- If `user` is absent, the widget sends no `reporter` field at all (same wire
  format as today).
- Display name for the widget's own UI (if ever needed): `name || email || id
  || 'anonymous'`.

Inside `postCapture`, the body becomes:

```js
{ kind, content, reporter: user ?? undefined }
```

`undefined` serializes cleanly (JSON.stringify drops the key).

### 2. API contract — `src/server/routes.js`

`POST /api/captures` accepts an optional `reporter` object:

```json
{
  "content": "pagination breaks on page 7",
  "kind": "bug",
  "reporter": { "id": "u_42", "name": "Alice", "email": "alice@zeno.com" }
}
```

Validation:
- If `reporter` is present, it must be a plain object (not array, not scalar).
  Reject with 400 otherwise.
- `id`, `name`, `email` each truncated to 255 chars before storage.
- Extra fields kept in a JSON blob column.
- If `reporter` is absent, all four columns are null (unchanged from today).

`GET /api/captures` accepts optional `?reporter_id=<id>` query param for
filtering.

### 3. Database — `src/server/db.js` migration v3

Add four nullable columns to `captures`:

```sql
ALTER TABLE captures ADD COLUMN reporter_id TEXT;
ALTER TABLE captures ADD COLUMN reporter_name TEXT;
ALTER TABLE captures ADD COLUMN reporter_email TEXT;
ALTER TABLE captures ADD COLUMN reporter_extra TEXT; -- JSON, everything else
CREATE INDEX IF NOT EXISTS idx_captures_reporter_id    ON captures(reporter_id);
CREATE INDEX IF NOT EXISTS idx_captures_reporter_email ON captures(reporter_email);
```

Migration follows the same pattern as v2 (line 278-285 of `db.js`): guarded by
`PRAGMA user_version < 3`, column-existence sniff for idempotency, then bumps
to 3.

### 4. Capture module — `src/server/captures.js`

`createCapture` gains an optional `reporter` param:

```js
createCapture({ project_id, content, kind, created_by, reporter })
```

- Splits `reporter` into the four columns. `reporter_extra` gets
  `JSON.stringify` of everything except `id`/`name`/`email`; null if empty.
- `getCapture` parses `reporter_extra` back before returning, and exposes a
  convenience `reporter` field on the returned object assembled from the four
  columns.
- `listCaptures` already does `SELECT c.*` so the columns flow through. Add
  an optional `reporter_id` filter arg.

### 5. Dashboard — `src/dashboard/` (and related components)

- **Capture list card:** when `reporter_name` (or `_email`) is present,
  display "by {name||email}" next to the timestamp.
- **Capture detail / thread header:** "Reported by Alice Cooper
  (alice@zeno.com)" above the message thread.
- **Filter control:** dropdown on the capture list populated from
  `SELECT DISTINCT reporter_id, reporter_name FROM captures WHERE project_id=?
  AND reporter_id IS NOT NULL`. Selecting a reporter adds `?reporter_id=` to
  the list query.

If the dashboard has no concept of capture filtering yet, the filter is a
small new control; list rendering already refreshes from the API, so no
architectural change.

### 6. Backward compatibility

| Case | Behavior |
|---|---|
| Old widget bundle (no `reporter` in payload) | Accepted, all four columns null. Nothing breaks. |
| EDMS with new widget, no `user` prop | Same as above. |
| EDMS with new widget, `user` prop set | Identity stored and displayed — bonus even for single-user. |
| Zeno with new widget, `user` prop set | Identity stored, displayed, filterable. |

## Files touched

- `src/react/DevPanel.jsx` — new `user` prop, pass through `postCapture`.
- `src/server/db.js` — migration v3 adding 4 columns + 2 indexes on `captures`.
- `src/server/captures.js` — `createCapture` accepts `reporter`; `getCapture`
  surfaces it; `listCaptures` filters on `reporter_id`.
- `src/server/routes.js` — `POST /api/captures` validates and forwards
  `reporter`; `GET /api/captures` accepts `reporter_id` query param.
- `src/dashboard/...` — capture list card, thread header, reporter filter
  dropdown (exact file paths TBD during implementation — dashboard layout
  isn't load-bearing for the data contract).
- `tests/` — unit tests for migration idempotency, create/list with and
  without reporter, filter by reporter_id, validation rejects non-object
  reporter.

## Risks

- **Widget bundle change requires a rebuild and republish of
  `@devpanel/react`.** Consumers (EDMS, Zeno) must upgrade the package. Not
  urgent — omitting the prop works fine.
- **Dashboard query for the filter dropdown could grow.** With thousands of
  captures and many reporters, `DISTINCT` on an indexed column is still cheap,
  but if the dropdown becomes a perf issue we cache on the dashboard side.
- **PII in SQLite.** Reporter emails land in the master DB. Not new — Franck's
  already there via `created_by='franck'` — but worth noting if/when a
  retention policy is drafted.

## Out of scope (for this change)

- Reporter on the per-project `tickets` table. Tickets are an older code path
  (`src/server/db.js` `createTicket`) used by the CLI review flow. Captures
  are where the widget lives and where the dashboard reads from. If ticket
  promotion eventually needs the reporter, carry it over at promotion time.
- Surfacing the reporter in Telegram messages Shelly posts. Possible follow-up
  but not required for the user-visible need.
