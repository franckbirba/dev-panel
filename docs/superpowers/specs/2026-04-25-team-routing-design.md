# Team routing per project — design

**Date:** 2026-04-25
**Status:** Ready for implementation plan
**Author:** Franck + Shelly

## Problem

The studio is no longer single-user. Zeno already has a three-person team:
d4jarvis owns *pedago*, AlexRussel owns *com*, geronimo owns *campus*. When a
bug or feature request arrives via the DevPanel widget on a project's site, it
silently lands in dev-panel's tickets table. Nobody is paged, nobody triages —
Franck has to notice it on the dashboard or in the morning digest. The
information about who-owns-what exists only in Franck's head; there is no
machine-readable mapping from a label to a person.

We want widget submissions to wake up the right person on Telegram, on the bot
that's already paired with them, with a reply path back into the ticket's
conversation.

## Goals

1. **Per-project team roster** — each project (Zeno, EDMS, dev-panel, …) owns
   its own list of people and routing rules. Adding `pedago` to Zeno does not
   leak into EDMS.
2. **Label-based routing** — a project defines a set of labels (`pedago`,
   `com`, `campus`, …) and maps each one to one team member.
3. **Settings UI** — Franck (or any project admin) can manage members and
   routing rules from `https://devpanl.dev/dashboard/settings` without editing
   files or running SQL.
4. **Widget-side classification** — the widget optionally lets the submitter
   pick a category from the project's labels; if they don't, Shelly classifies
   from title + description.
5. **Telegram delivery** — the routed person gets a DM on *their* paired bot
   (Alex on `@AlexRusselBot`, Geronimo on `@geronimo_zeno_bot`, …), prefixed
   with `[thread:ticket/<id>]` so their replies route back to the ticket
   conversation.

## Non-goals

- Routing on **Plane work items** — out of scope for this spec. Plane labels
  may end up sharing names with dev-panel's routing labels but they are not
  the same data.
- Multiple owners per label — one label routes to exactly one person. Pairs
  / round-robin / on-call rotations are explicitly out.
- Re-routing already-routed tickets when the team config changes. Tickets
  freeze the routing decision they got.
- Global studio-wide routing rules. Each project is self-contained.
- A separate roles model (e.g. "admin / reviewer / observer"). Membership in
  a project's team is a flat list.

## Architecture

### Data model — two new Postgres tables (migration 006)

```sql
CREATE TABLE team_members (
  id              SERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL,                       -- references projects.id (sqlite, no FK)
  display_name    TEXT NOT NULL,
  dev_bot_id      INTEGER REFERENCES dev_bots(id),     -- nullable until paired
  tg_user_id      BIGINT,                              -- denormalized from dev_bots.owner_tg_user_id
  added_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, display_name)
);
CREATE INDEX team_members_project_idx ON team_members(project_id);

CREATE TABLE team_routing (
  id              SERIAL PRIMARY KEY,
  project_id      TEXT NOT NULL,
  label           TEXT NOT NULL,
  member_id       INTEGER NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE (project_id, label)
);
CREATE INDEX team_routing_project_idx ON team_routing(project_id);
```

Tables live in shared Postgres (same place as `dev_bots`, `dev_bot_allowlist`)
because both the API on services VPS and Shelly's MCP on agents VPS need to
read them. `project_id` stays `TEXT` with no FK — projects live in SQLite on
the services host; this asymmetry is established (003-orchestration-pg.sql).

### Ticket schema additions — per-project SQLite migration

`storage/<projectId>/tickets.db` gets three columns added to the `tickets`
table via in-code `ALTER TABLE IF NOT EXISTS` (matching the pattern in
`db.js`):

```sql
routed_label      TEXT,
routed_member_id  INTEGER,
routed_at         DATETIME
```

These let the dashboard show "routed to Alex (com)" on a ticket card and let
Shelly's `route_ticket` be idempotent on retry.

### API — new routes under existing per-project auth

Mounted from a new `src/server/routes-team.js`, called from `routes.js` next
to dev-bots routes. All require the project's `X-API-Key` header — same auth
posture as `/api/tickets` and `/api/captures`. The widget already ships the
project key in its bundle to call `POST /api/tickets`, so there is no extra
exposure introducing `GET /api/team/labels`.

```
GET    /api/team
GET    /api/team/labels
POST   /api/team/members
PATCH  /api/team/members/:id
DELETE /api/team/members/:id
GET    /api/team/routing
PUT    /api/team/routing                  (full replace, transactional)
DELETE /api/team/routing/:label
GET    /api/dev-bots/available?project=…
POST   /api/tickets/:id/route             (idempotent, used by Shelly)
```

Response shapes — see "API contract" section below.

### Widget — optional category dropdown

`src/react/DevPanel.jsx` fetches `/api/team/labels` once on mount. If the list
is non-empty, the form renders a `<select>` with options `— Auto (Shelly
choisit) —` plus one entry per label, formatted `label (member_name)`. The
selection is sent in `POST /api/tickets` as a new optional `category` field.

If labels is empty (`team_routing` empty for the project), the dropdown is not
rendered. Existing widgets are visually unchanged on projects without team
config.

### Settings UI — new "Team" tab

`src/dashboard/views/settings-view.jsx` gets a `team` section between
`github` and `notifications`. Two stacked tables in one column:

1. **Members** — display_name, bot username + label, owner first_name,
   Edit/Remove. Adding a member opens an inline form: `display_name` text
   input + `dev_bot_id` dropdown sourced from
   `GET /api/dev-bots/available?project=<id>`.
2. **Routing** — label, member dropdown, Remove. Adding a row appends a new
   `{label, member_id}`. Edits stay client-side until **Save routing**, which
   fires the full-replace `PUT /api/team/routing`.

Empty states:
- No members: *"Définis qui s'occupe des bug reports pour ce projet. Chaque
  personne a besoin d'un bot Telegram pairé — voir `/pair` dans le channel
  Telegram."*
- No bots available: *"Aucun bot disponible — paire-en un en Telegram d'abord :
  envoie `/pair <token> <label>` à `@Therealshelly42bot`."*

### Notification pipeline

```
User → DevPanel widget → POST /api/tickets
                              │
              persist ticket; if category set, write routed_label early
                              │
              emit [ticket-new] system message in Shelly's channel
                              │
                  Shelly receives [ticket-new]
                              │
   if no category:  classify against /api/team/labels (LLM)
                              │
                  POST /api/tickets/:id/route (idempotent)
                              │
            DM resolved member on their dev_bot
            with [thread:ticket/<id>] prefix
                              │
                  Reply path: thread protocol routes Telegram
                  inbound back into ticket conversation
```

#### `[ticket-new]` system message format

Posted to Shelly's Telegram channel by the API (using the existing
`notifyJob`-style push to the legacy bot Franck owns), one line:

```
[ticket-new] project=<name> ticket=<id> category=<label-or-empty> title="<truncated 100 chars>"
```

Shelly's SOUL gets a paragraph telling her: when you see `[ticket-new]`, call
`get_team_labels(project)` if no category, classify, then `route_ticket(...)`,
then DM the resolved member with the thread tag.

#### New MCP tools (devpanel-mcp on agents host)

Added to `src/mcp/server.js`, all using the `projectFetch` helper added on
2026-04-25:

- `get_team_labels(project)` → wraps `GET /api/team/labels`
- `get_team_member(project, member_id)` → wraps `GET /api/team` and pulls the
  matching member with their `dev_bot` and `tg_user_id`
- `route_ticket(project, ticket_id, label)` → wraps
  `POST /api/tickets/:id/route`; returns `{member, dev_bot, already_routed}`

The actual Telegram DM uses the existing `plugin:telegram:reply` tool from
the telegram-multi plugin (no new tool there).

#### Failure modes

| Condition | Behaviour |
|---|---|
| `team_routing` empty for project | Shelly skips classification; pings Franck once: "Nouveau bug sur \<project> mais pas de team configurée." |
| Label has no member | Same — fallback to Franck. |
| Member's `dev_bot_id` is null | Same — fallback. |
| Telegram 409 / network error | Retry once after 30 s; if still failing, post `[ticket-routing-failed]` in the ticket conversation so the dashboard shows it. |
| Duplicate `[ticket-new]` fires | `POST /api/tickets/:id/route` is idempotent on `routed_label`; returns `already_routed: true`; Shelly skips the DM. |
| Routing config edited mid-flight | Already-routed tickets don't re-route; new tickets use the new map. |

## API contract

### `GET /api/team`

```json
{
  "members": [
    {
      "id": 1,
      "display_name": "Alex",
      "dev_bot": { "id": 4, "label": "alex", "username": "AlexRusselBot" },
      "tg_user_id": "12345678"
    }
  ],
  "routing": [
    { "label": "com", "member_id": 1, "member_name": "Alex" }
  ]
}
```

### `GET /api/team/labels`

```json
[
  { "label": "pedago",  "member_name": "d4jarvis" },
  { "label": "com",     "member_name": "Alex" },
  { "label": "campus",  "member_name": "Geronimo" }
]
```

### `POST /api/team/members`

Request: `{ "display_name": "Alex", "dev_bot_id": 4 }`
Response 201: `{ "id": 1, "display_name": "Alex", "dev_bot": {...}, "tg_user_id": "..." }`
Errors: 400 if `dev_bot_id` doesn't exist, 409 if `(project_id, display_name)` collision.

### `PUT /api/team/routing`

Request: `[{"label": "pedago", "member_id": 3}, {"label": "com", "member_id": 1}, ...]`
Response 200: same payload echoed back.
Server transactionally deletes all rows for the project and inserts the new set.

### `POST /api/tickets/:id/route`

Request: `{ "label": "com" }`
Response 200:
```json
{
  "ticket_id": 42,
  "label": "com",
  "member": { "id": 1, "name": "Alex" },
  "dev_bot": { "label": "alex", "username": "AlexRusselBot", "tg_user_id": "12345678" },
  "already_routed": false
}
```
If ticket already has `routed_label`, returns the existing routing with
`already_routed: true` and ignores the request body.
404 if ticket doesn't exist; 409 if label has no member.

### `GET /api/dev-bots/available?project=<projectId>`

Returns the subset of `dev_bots` (status `active`) that are not yet linked to
a `team_member` of this project:

```json
[
  { "id": 4, "bot_label": "alex", "bot_username": "AlexRusselBot",
    "owner_first_name": "Alex" }
]
```

## Testing

- **Migration 006** has its own integration test that creates a temporary
  Postgres schema, runs the migration, asserts table existence and uniqueness
  constraints.
- **API routes** get integration tests in `tests/server/routes-team.test.js`:
  CRUD on members, full-replace PUT on routing, idempotency of
  `POST /api/tickets/:id/route`, fallback when label has no member.
- **Widget** gets a Storybook story showing the dropdown rendered vs. hidden,
  driven by a mocked `/api/team/labels` response.
- **Settings UI** gets a Storybook story for both empty and populated states.
- **Shelly behaviour** — manual smoke test from this conversation: post a
  ticket via the widget on Zeno's site, watch the right bot DM Alex /
  Geronimo / d4jarvis, reply from Telegram, see the reply land in the ticket
  conversation in the dashboard. Shelly's classifier doesn't get unit tests
  this round (LLM-bound, low payoff for the size of this change).

## File-level impact

New files:
- `infra/migrations/006-team-routing.sql`
- `src/server/team.js` (DAO + classifier helper)
- `src/server/routes-team.js`
- `src/dashboard/views/settings-team-panel.jsx` (extracted to keep
  `settings-view.jsx` from growing further; existing panels stay inline).
- `tests/server/routes-team.test.js`

Modified:
- `src/server/db.js` — `ALTER TABLE` for `routed_label`, `routed_member_id`,
  `routed_at` on per-project tickets.db.
- `src/server/routes.js` — `POST /api/tickets` accepts `category` and emits
  `[ticket-new]`; mount routes-team.
- `src/server/index.js` — call `mountTeamRoutes(app)`.
- `src/server/routes-dev-bots.js` — add `GET /available?project=<id>` filter.
- `src/server/alerts.js` — new `notifyTicketNew(ticket)` helper that posts
  the `[ticket-new]` line into Shelly's channel.
- `src/mcp/server.js` — three new tools.
- `src/react/DevPanel.jsx` — labels fetch + dropdown.
- `src/dashboard/views/settings-view.jsx` — wire new `team` section.
- `.agents/shelly/SOUL.md` — paragraph on `[ticket-new]` reaction protocol.

## Open questions

None at design time — all of the choices above were validated in the
brainstorming pass. The implementation plan should resolve any remaining
detail-level decisions (e.g. exact wording of Shelly's classification prompt,
exact French copy for the empty states beyond the drafts above).
