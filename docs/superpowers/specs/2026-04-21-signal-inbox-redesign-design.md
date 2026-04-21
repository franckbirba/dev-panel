# DevPanel Signal Inbox Redesign

**Date:** 2026-04-21
**Status:** Approved design, ready for implementation planning
**Driver:** Franck (sole user / operator)

## Problem

The current dashboard is **project-first** (switch project → see its Today/Captures/Inbox/Dashboard) and fragments the operator's actual workflow across four overlapping views. Adding a new project requires filling Plane UUIDs, workspace slugs, local paths, and an admin key — Franck has not been able to add `zeno` or `EDMS` because of this friction.

Franck's real mental model: **"My agents work for me. Show me what's blocked, what needs my decision, what shipped, what failed — across all projects."** Triage, prioritization, and conversations with Shelly should happen in one place. Bug reports come in with screenshots from the floating widget; those screenshots are core, not a sidebar afterthought.

## Goals

- One cross-project cockpit where every actionable event surfaces in priority order.
- Per-subject conversation threads that sync with the Telegram channel where Shelly already lives.
- Paste-a-GitHub-URL project bootstrap. No UUIDs, no manual local paths.
- User-driven priority lanes (`now` / `today` / `later`) that attach to the underlying subject and persist across signals.
- Screenshots first-class on rows and in threads.
- Additive backend, zero data migration, three-stage rollout behind a feature flag.

## Non-Goals (v1)

- Security alert ingestion (Dependabot/CodeQL) — v2.
- Editing past messages, message reactions, file attachments in threads.
- Mobile-specific UI (the dashboard is operator-facing on desktop; Telegram covers mobile).
- Replacing the floating widget UX — only the operator-side dashboard changes.

---

## Information Architecture

**Five top-level tabs:**

| Tab | Purpose |
|---|---|
| **Signals** *(default)* | Cross-project event feed. Replaces Today + Captures + Inbox + Dashboard. |
| **Projects** | Manage projects. Paste-URL add flow. |
| **Shelly** | Freeform chat with Shelly for general questions not tied to a subject. |
| **Queues** | BullMQ ops (kept for debugging, demoted from primary nav). |
| **Settings** | Admin key, feature flags, theme. |

**URL preservation:** existing routes `/dashboard/today`, `/dashboard/captures`, `/dashboard/inbox` 301 to `/dashboard/signals?project=<current>` once Stage 3 lands. During Stage 2 they keep working.

**Removed views (Stage 3):** `today-view.jsx`, `captures-view.jsx`, `inbox-view.jsx`, `dashboard-view.jsx`. Their data flows into the Signals feed.

---

## Signal Inbox

### Layout

A single feed grouped into three urgency bands. Bands have sticky collapsible headers.

| Band | Color | Contents | Default state |
|---|---|---|---|
| **Needs you** | Red | Agent question, exhausted/needs-input workflow, failed deploy, security alert (v2), blocked job, capture older than 2h with `last_role=shelly` | Expanded |
| **In flight** | Amber | Running jobs, in-progress workflows, captures being triaged | Collapsed |
| **Shipped / FYI** | Green | Deploys OK, features merged, ships in last 24h | Collapsed |

### Row anatomy

```
┃ [project · type] [📷] Title in one line          [age] [● now] [● today] [● later] [⋯ inline actions]
```

- **Left edge:** thick colored bar = priority lane (`now` red, `today` amber, `later` gray, none = thin border).
- **`project · type`:** muted chip pair, e.g. `zeno · bug`, `edms · capture`, `dpanl · deploy`.
- **`📷`:** present when subject has ≥1 screenshot. Hover/tap shows mini-preview popover.
- **Title:** single line, truncate with ellipsis.
- **Priority buttons:** three small dots, one filled (current state), others outlined. Click toggles. Setting `now` while `today` was set replaces it.
- **Inline actions:** 1–2 signal-type-specific buttons that don't need words: `retry`, `approve`, `drop`, `promote`, `→ logs`. Everything else opens the thread.

### Filters bar

Above the feed:

```
[all] [● now] [● today] [● later]   |   projects: [all] [zeno] [edms] [dpanl] ...   |   types: [blockers] [questions] [captures] [deploys] [security] [ships]   |   [☐ needs me only]
```

- Multi-select per group.
- State persisted in URL query string (so refresh / share-a-link works).
- Default landing: `[● now] + [needs me only]` — "what did I flag yesterday + what blew up overnight."

### Live updates

Existing SSE channel `/api/events` is reused. New event types added: `signal:new`, `signal:resolved`, `subject:priority_changed`, `thread:message`. New rows pop at top with a 2-second highlight, no full reload.

### Empty states

- "Needs you" empty: `Nothing on you. Agents are working.` with the in-flight count below as a quiet reassurance.
- Whole feed empty (new install, before any project added): single CTA card → opens the paste-URL modal from Projects tab.

---

## Thread Panel

### Behavior

- Click any row → right-side panel slides in (40% viewport width on desktop, full-screen takeover below 768px).
- Esc or click-outside closes.
- The panel state is in the URL: `/dashboard/signals?thread=work_item/ZENO-42`. Refreshable, shareable.

### Contents

```
┌─────────────────────────────────────────────┐
│ ZENO-42 · Login button overlaps modal   ✕  │  ← header: subject title
│ zeno · bug · [Plane ↗] [GitHub ↗]          │  ← link-outs to source-of-truth
├─────────────────────────────────────────────┤
│ [thumb1] [thumb2] [thumb3]                  │  ← screenshot gallery strip
├─────────────────────────────────────────────┤
│ system  deploy #141 failed 12m ago          │
│ shelly  L'agent est bloqué, il lui faut    │
│         la clé Stripe sandbox.              │
│ you     mets-la dans .env.zeno              │
│ shelly  ✓ dispatched retry                 │
│ system  job 8421 running                    │
├─────────────────────────────────────────────┤
│ [reply to shelly…]                  [send] │
└─────────────────────────────────────────────┘
```

- **Gallery strip:** thumbnails of all screenshots attached to the subject. Click → fullscreen lightbox. Reuses `/api/tickets/:id/screenshot` for ticket-typed subjects; new endpoint for capture/work_item screenshots if needed (currently captures don't store screenshots — non-goal in v1).
- **Inline screenshots in messages:** when a message references a screenshot, the image renders at original size beneath the text.
- **System events** are interleaved as muted gray rows so the timeline is unified — you don't context-switch between "chat" and "log".
- **Reply box:** plain markdown text, send on `Cmd/Ctrl+Enter` or button. No file upload in v1.

### Subject types & threading

A thread is keyed on `(subject_type, subject_id)`. Subject types in v1:

- `work_item` — Plane work item
- `capture` — DevPanel capture (existing model)
- `ticket` — DevPanel ticket from the floating widget (with screenshots)
- `pr` — GitHub pull request
- `deploy` — deploy event
- `job` — BullMQ job

Future signals about the same subject append to the same thread. Captures that get `promoted` to a Plane work item carry their thread forward: a `system` row is inserted ("promoted to ZENO-42"), and the existing `threads` row is re-pointed from `(capture, <cap_id>)` to `(work_item, <wi_id>)`. The capture's row in the feed disappears (status filter); the work_item now owns the conversation. Implementation may instead use a small `thread_subjects` join table if planning prefers many-to-one mapping — non-blocking design choice.

### Telegram sync

**Outbound (dashboard → Telegram):**
- Every reply is posted to the Telegram channel via the existing `notifyJob()`-style sender, with a tag prefix:
  ```
  [thread:work_item/ZENO-42] mets-la dans .env.zeno
  ```
- The tag is human-readable; Shelly sees it and treats it as context.

**Inbound (Telegram → dashboard):**
- Shelly's persona instructions are extended: *"When responding about a subject, prefix your reply with the same `[thread:<type>/<id>]` tag so the dashboard can attach the message to the right thread."*
- A server-side parser inspects every inbound channel message. If it starts with `[thread:<type>/<id>]`, the rest of the message body is appended as a `thread_messages` row with `source='telegram'`.
- Untagged inbound messages stay in the freeform Shelly tab. Degrades gracefully if Shelly forgets to tag.

**Idempotency:** every inbound Telegram message carries a `message_id`. Stored on `thread_messages.telegram_message_id` to deduplicate on retry.

---

## Priority Lanes

Three user-driven lanes orthogonal to system urgency:

| Lane | Color | Meaning |
|---|---|---|
| `now` | Red | Drop everything, this matters now. |
| `today` | Amber | Must be in today's batch. |
| `later` | Gray | Wanted, not urgent. |
| *(null)* | — | Backlog / unsorted. |

**Where they appear:**

1. Inline three-button cluster on every signal row.
2. Colored left edge of the row (visual scan).
3. Filter chips in the header bar.

**Storage:** `subjects.priority` column. Set by `PATCH /api/subjects/:type/:id`. Single value (a subject is either `now`, `today`, `later`, or null — not all three).

**Inheritance:** priority attaches to the **subject**, not the signal. Future signals about the same subject inherit the lane until cleared. Promoting a capture to a work item carries the priority over.

---

## Paste-URL Project Add Flow

### UI

```
┌─────────────────────────────────────────────┐
│ Add project                            ✕   │
├─────────────────────────────────────────────┤
│  GitHub repo                                │
│  [https://github.com/franck/zeno________]  │
│                                             │
│             [ Add and bootstrap → ]        │
│                                             │
│  ▸ Advanced                                 │
└─────────────────────────────────────────────┘
```

One field. Advanced is collapsed and almost never needed.

### Server-side flow on `POST /api/projects/from-github`

1. **Parse URL.** Accept `https://github.com/<owner>/<repo>(.git)?`, `git@github.com:<owner>/<repo>.git`, or `<owner>/<repo>` shorthand. Reject anything else with `400 invalid github url`.
2. **GitHub probe.** `GET /repos/<owner>/<repo>` via the configured GitHub token. Capture `name`, `description`, `default_branch`, `language`. On 404 / 401, abort before any writes with the precise error.
3. **Create Plane project.** `POST /workspaces/<slug>/projects/` with `name=<repo>`, `identifier=<UPPERCASE(repo) truncated to 5>`. On name conflict, retry with `<name>-2`. Workspace slug from env `PLANE_WORKSPACE_SLUG` (already used elsewhere).
4. **Mint API key.** Generate `dp_<uuid>`, insert row into `projects` table (master `projects.db`).
5. **Enqueue bootstrap job.** New BullMQ job type `bootstrap_project` with payload `{project_id, github_url, target_path: "/home/deploy/projects/<repo>"}`. Worker on agents host runs `git clone`, posts back status via existing `notifyJob()`. Project is usable immediately; the row in Projects view shows a `cloning…` pill until done.
6. **Return** the assembled project record so the dashboard can switch to it.

### Admin key handling

- First add: modal includes a small admin-key field with "remember on this device".
- Cached in `localStorage` under `devpanel:admin_key` (already exists in [src/dashboard/lib/projects-store.js](src/dashboard/lib/projects-store.js)).
- Subsequent adds: no admin-key field shown.
- Wrong/expired key: a row appears at the top of Projects view with a re-enter prompt. No silent failure.

### Error handling

Each step surfaces inline. We do **not** auto-rollback partial creates by default — Franck would rather see "Plane created OK, GitHub clone failed" and retry the clone than have to redo the whole thing.

- GitHub fail → no writes, modal shows error, retry possible.
- Plane fail → no writes, modal shows error, retry possible.
- Clone fail (after Plane + DB writes) → project exists in DevPanel + Plane, surfaced as a `Needs you` signal: `bootstrap zeno failed — ssh deploy@hetzner-vps couldn't reach github`. Retry from the signal row.

### Advanced accordion (rarely opened)

Keeps existing fields: custom local path, link-existing-Plane-project (skip step 3), custom default branch, custom GitHub owner override.

---

## Data Model

All changes are additive. No table renames, no destructive migrations.

### New tables (master `projects.db`)

```sql
CREATE TABLE subjects (
  subject_type     TEXT NOT NULL,        -- work_item | capture | ticket | pr | deploy | job
  subject_id       TEXT NOT NULL,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  title            TEXT,
  priority         TEXT,                 -- now | today | later | NULL
  priority_set_at  DATETIME,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (subject_type, subject_id)
);
CREATE INDEX subjects_priority ON subjects(priority) WHERE priority IS NOT NULL;
CREATE INDEX subjects_project  ON subjects(project_id);

CREATE TABLE threads (
  thread_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type     TEXT NOT NULL,
  subject_id       TEXT NOT NULL,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_message_at  DATETIME,
  UNIQUE (subject_type, subject_id)
);

CREATE TABLE thread_messages (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id             INTEGER NOT NULL REFERENCES threads(thread_id),
  role                  TEXT NOT NULL,    -- user | shelly | system | agent
  source                TEXT NOT NULL,    -- web | telegram | system
  content               TEXT NOT NULL,
  telegram_message_id   INTEGER,          -- for inbound dedup
  created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX thread_messages_thread ON thread_messages(thread_id, created_at);
CREATE UNIQUE INDEX thread_messages_tg_dedup
  ON thread_messages(telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;

CREATE TABLE deploy_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  status       TEXT NOT NULL,       -- started | succeeded | failed
  sha          TEXT,
  ref          TEXT,
  log_url      TEXT,
  failed_reason TEXT,
  started_at   DATETIME,
  finished_at  DATETIME,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX deploy_events_project_created ON deploy_events(project_id, created_at DESC);
```

### Existing tables — unchanged

`projects`, `tickets` (per-project DBs), `captures`, `workflow_state`, BullMQ Redis state. The Signals feed reads from these via SQL joins; no schema change.

### Subject lifecycle

The `subjects` row is upserted **on first appearance** in any feed. The aggregator query for `/api/signals` does:

```
LEFT JOIN subjects USING (subject_type, subject_id)
```

If absent, default `priority=NULL`. When the user clicks a priority button, `PATCH /api/subjects/:type/:id` upserts the row with the chosen value.

---

## API Surface

### New endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`   | `/api/signals` | Cross-project aggregator. Query: `project`, `type`, `priority`, `needs_me_only`, `since`. Returns `[{subject_type, subject_id, project_id, project_name, signal_type, urgency, title, age_min, screenshots[], priority, has_thread, actions[]}]`. Auth: API key or admin key. |
| `GET`   | `/api/threads/:subject_type/:subject_id` | Fetch (lazy-create) a thread + its messages. |
| `POST`  | `/api/threads/:subject_type/:subject_id/messages` | Append a user message; server forwards to Telegram with `[thread:...]` tag. |
| `PATCH` | `/api/subjects/:subject_type/:subject_id` | Set/clear priority. Body: `{priority: "now"\|"today"\|"later"\|null}`. |
| `POST`  | `/api/projects/from-github` | Paste-URL bootstrap. Body: `{github_url, admin_key?}`. |

### Reused / unchanged

`/api/today`, `/api/captures`, `/api/activity`, `/api/stats`, `/api/whoami`, `/api/projects`, `/api/projects/summary`, `/api/events` (SSE) — kept during Stages 1 + 2, removed in Stage 3 only if no longer referenced.

### New SSE event types on `/api/events`

| Event | Payload |
|---|---|
| `signal:new`           | A row that should appear at the top of the feed. |
| `signal:resolved`      | A row that should be removed (e.g. job retried successfully). |
| `subject:priority_changed` | `{subject_type, subject_id, priority}` — re-color row across all open clients. |
| `thread:message`       | `{thread_id, message}` — append to open thread panel without polling. |

---

## Telegram Tag Protocol

A small text protocol layered on top of the Telegram channel.

**Tag format:** `[thread:<subject_type>/<subject_id>] <message body>`

- `<subject_type>` is one of `work_item | capture | ticket | pr | deploy | job`.
- `<subject_id>` is opaque (no spaces, no `]`).
- The tag MUST start at character 0 of the message body, no leading whitespace.

**Outbound** (server → Telegram, when user replies in dashboard): server prepends the tag automatically based on the panel's open subject.

**Inbound** (Telegram → server): the channel handler runs `parseThreadTag(message.text)` first. If matched: insert into `thread_messages` with `source='telegram'`, `telegram_message_id=<message.message_id>`, role inferred from sender. If not matched: route to the freeform Shelly tab (existing behavior).

**Shelly persona update** ([CLAUDE.md](CLAUDE.md), Shelly section): add a hard rule — *"When you reply about a specific subject the user raised in the dashboard, prefix your reply with `[thread:<type>/<id>]` so the conversation threads correctly."*

**Failure mode:** if Shelly drops the tag, the message lands in freeform Shelly. The thread looks like the user's message went into the void. Mitigations:
- Server retries Shelly's last reply lookup by recency + sender heuristic and offers an "attach to thread" button on the freeform message.
- Persona doc spells the rule loudly.

---

## Worker Additions (agents host)

One new BullMQ job type:

```
bootstrap_project
  payload: { project_id, github_url, target_path }
  steps:
    1. mkdir -p $(dirname target_path)
    2. git clone github_url target_path
    3. on success → notifyJob({project_id, status:'bootstrap_succeeded'})
    4. on failure → notifyJob({project_id, status:'bootstrap_failed', error})
  retries: 2, backoff: exponential 30s
```

Existing `notifyJob()` writes to `deploy_events` with a `status='bootstrap_succeeded'|'bootstrap_failed'` value (one table for all infra events; bootstrap is a special status), and surfaces as a signal.

---

## Rollout

Three stages, each independently revertable.

### Stage 1 — Backend additive (~2-3 days)

- Migrations for `subjects`, `threads`, `thread_messages`, `deploy_events`.
- New endpoints listed above.
- `notifyJob()` extension to write `deploy_events` rows.
- Telegram tag parser + outbound prepender, behind env flag `DEVPANEL_THREAD_SYNC=on`.
- Shelly persona doc updated.
- Existing UI continues working unchanged.
- Manual smoke test: `POST /api/projects/from-github` for a throwaway repo.

### Stage 2 — Signals UI behind feature flag (~1 week)

- New `/dashboard/signals` route.
- New components: `<SignalsView>`, `<SignalRow>`, `<PriorityButtons>`, `<ThreadPanel>`, `<GalleryStrip>`, `<FilterBar>`, `<PasteUrlModal>`.
- Feature flag in Settings: `Try the new Signals view`. Off by default. Stored in localStorage.
- Old views remain default. Franck dogfoods, files captures via the floating widget when something sucks, iterates.

### Stage 3 — Promote and remove (when Franck says go)

- `/dashboard/` redirects to `/dashboard/signals`.
- Old routes 301 for ~2 weeks.
- After grace period: delete `today-view.jsx`, `captures-view.jsx`, `inbox-view.jsx`, `dashboard-view.jsx` and their endpoints if no other consumer depends on them.

### Data migration

**None.** All existing data already exists. New tables are additive. The new feed is a *view* over what's already there.

---

## Risks & Open Questions

| Risk | Mitigation |
|---|---|
| Shelly forgets the `[thread:...]` tag → messages land in freeform | Persona rule + recency-based "attach to thread" rescue button on freeform messages. |
| Telegram poller dedup glitch creates duplicate thread messages | Unique index on `thread_messages.telegram_message_id`. |
| Bootstrap clone takes minutes for large repos, blocks visibility | Async job, project usable immediately, `cloning…` pill on the row. |
| `subjects` table grows unbounded as ephemeral subjects (jobs) accumulate | Periodic cleanup: delete `subjects` rows where `priority IS NULL` and the related entity hasn't been seen in 90 days. |
| Right-side thread panel wastes screen on narrow displays | Below 768px viewport, panel becomes full-screen takeover with back button. |
| Existing widget doesn't capture screenshots into the new `subject` model | Tickets already store screenshots as BLOBs at `/api/tickets/:id/screenshot`. The `subject_type=ticket` rows reuse that endpoint directly. No widget change needed. |
| Captures don't carry screenshots today | Out of scope for v1. Capture rows show `[📷]` only when promoted to a ticket/work_item that has them. |

---

## Acceptance Criteria

- [ ] Adding a project takes one paste of a GitHub URL. No UUIDs typed. Repo is cloned to agents host async; project is usable immediately.
- [ ] Opening the dashboard with no filters shows ≥1 actionable cross-project row when there is one (verified by manually failing a job in any project and refreshing).
- [ ] Clicking a row opens a thread panel that shows the subject's full conversation, including past Telegram messages tagged for that subject.
- [ ] Sending a reply in the dashboard appears in the Telegram channel within 2s, prefixed with the thread tag.
- [ ] A tagged Telegram reply from Shelly appears in the open thread panel within 5s without manual refresh.
- [ ] Setting priority `now` on a subject persists across page reload, future signals for that subject inherit the lane.
- [ ] Filter chips persist in the URL.
- [ ] Old routes (`/dashboard/today`, etc.) keep working through Stage 2.
- [ ] Feature flag toggle in Settings switches between old and new UI without losing localStorage state.
