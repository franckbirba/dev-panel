# PR Merge → Release Note Broadcast — Design

**Date:** 2026-04-28
**Status:** Draft
**Owner:** Franck

## Problem

When a pull request gets auto-merged on a repo handled by DevPanel
(`dev-panel`, `zeno`, `edms`, …), only Franck hears about it — the
existing `notifyJob('publisher', …)` line goes to a single Telegram
chat, and even that fires when auto-merge is *queued*, not when it
actually completes. The team doesn't get a release note.

The branch `feat/wi-7096cee4-...` (Shelly-dispatched, not yet merged)
adds a webhook that listens to `pull_request: opened|reopened|synchronize`
and dispatches a `merge-coordinator` workflow. It does **not** handle
the terminal `closed + merged=true` event, and it does no team fan-out.

This spec adds that piece.

## Goal

When GitHub fires `pull_request.closed` with `merged === true` on any
repo wired to the DevPanel webhook, every paired Telegram bot
(`dev_bots WHERE status='active'`) receives one human-readable release
note containing PR title, author, link, and the list of commits that
shipped.

## Non-goals

- LLM-generated narrative summaries. The commits-as-bullets format is
  cheap, deterministic, debuggable.
- Notifying on `closed + merged=false`. Closed-without-merge is silent.
- Per-user opt-out. Every active bot gets every merge for now. If
  noise becomes a problem we add a `notify_releases` column later.
- Per-repo allow/deny. Every repo that points at the webhook is in
  scope. Filtering happens upstream by simply not configuring the
  webhook on a repo.
- Retry on `sendMessage` failures. Best-effort, log, move on.

## Architecture

### Trigger path

```
GitHub pull_request.closed (merged=true)
        │
        ▼
POST /api/webhooks/github  (verifies HMAC, parses payload)
        │
        ▼
  is action=closed and pr.merged=true ?
        │  yes
        ▼
  recordBroadcast(synthetic_id) — INSERT … ON CONFLICT DO NOTHING
        │  if row was inserted (i.e. first time we see this merge)
        ▼
  fetchCommits(repo, pr_number)   → GitHub REST /repos/:r/pulls/:n/commits
        │
        ▼
  buildReleaseNote(pr, commits, planeRef) → string
        │
        ▼
  fanOut(text)
    └─ for each row in dev_bots WHERE status='active':
         POST https://api.telegram.org/bot<token>/sendMessage
              chat_id = owner_tg_user_id
              text    = release note
         (errors logged, never thrown)
```

### File layout

| File | Role |
|------|------|
| `src/server/webhooks-github.js` | Existing handler — extend to accept `closed` action and branch on `pr.merged`. |
| `src/server/release-notes.js` | New. `buildReleaseNote()`, `fetchCommits()`, `broadcastRelease()`, `recordBroadcast()`. |
| `infra/migrations/008-release-broadcasts.sql` | New table `release_broadcasts(synthetic_id PK, broadcast_at)`. |
| `tests/server/release-notes.test.js` | Build + commit-fetch unit tests. |
| `tests/server/webhooks-github-merged.test.js` | Handler integration: closed+merged → broadcast called once. |

### Data model

```sql
-- 008-release-broadcasts.sql
CREATE TABLE IF NOT EXISTS release_broadcasts (
  synthetic_id  TEXT PRIMARY KEY,           -- "github:owner/repo#123:merged"
  broadcast_at  TIMESTAMPTZ DEFAULT now()
);
```

Idempotence is the single concern. We don't store the rendered note,
the commit list, or the recipient set. `INSERT … ON CONFLICT DO
NOTHING RETURNING synthetic_id` tells us "first time vs replay" in one
round-trip — if no row comes back, GitHub re-delivered an event we
already broadcast and we exit silently.

### Synthetic ID

`github:<repo>#<pr_number>:merged` — distinct from the
`merge-coordinator` synthetic ID `github:<repo>#<pr_number>` already
used by `webhooks-github.js`. Different purposes, different tables, no
collision.

### Release note format

```
Merged — <repo> #<pr_number>: <title>
by @<author>  ·  <files_changed> files, +<additions>/-<deletions>

• <sha7> <commit subject>
• …
(+N more)            ← only if commits.length > 8

<plane_url>          ← only if planeRef matched (https://plane.devpanl.dev/devpanl/projects/<pid>/issues/<seq>/)
<pr_html_url>
```

Plain text. No Markdown parse_mode (Telegram strips/escapes
inconsistently across bot versions; plain text is bulletproof). Cap
commit list at 8, append `(+N more)` if truncated. Body of the PR is
ignored — too noisy, often boilerplate. The commit subjects already
carry the "what shipped" signal.

`planeRef` reuses `extractPlaneRef(branch, title)` already exported by
`webhooks-github.js`. If it matches a sequence-style ref (DEVPA-93),
we have enough to build the URL. UUID-style refs would need a Plane
API roundtrip — for v1 we skip the link in that case rather than add a
new dependency on Plane being reachable.

### Fan-out

```js
// src/server/release-notes.js
import { listActive } from './dev-bots.js';   // already exists

export async function fanOut(text) {
  const bots = await listActive();
  await Promise.allSettled(bots.map(b =>
    sendTelegram(b.bot_token, b.owner_tg_user_id, text)
  ));
}

async function sendTelegram(token, chatId, text) {
  if (!chatId) return;  // bot paired but owner never DM'd it yet
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!r.ok) console.warn(`[release] sendMessage ${r.status} for chat=${chatId}`);
  } catch (err) {
    console.warn(`[release] sendMessage failed for chat=${chatId}: ${err.message}`);
  }
}
```

`Promise.allSettled` so one bad token (revoked, owner blocked the bot)
doesn't poison the broadcast for everyone else. No retry — push-only
sends are cheap and Telegram is reliable enough that occasional drops
are acceptable.

### Webhook integration

`src/server/webhooks-github.js` changes:

1. Add `'closed'` to `ALLOWED_ACTIONS`.
2. After parsing `pr` and validating `repo` / `prNumber`, branch:
   - If `payload.action === 'closed'` and `pr.merged === true`:
     call `broadcastRelease({ repo, pr_number: prNumber, pr, branch, prTitle })`
     and return `202` (or `204` if the broadcast was a replay).
     Do **not** dispatch a `merge-coordinator` — the PR is closed.
   - Otherwise (open/reopen/synchronize): existing dispatch logic.

The two code paths are independent: an `opened` event still fires
`merge-coordinator`; a `closed+merged` event still fires the
broadcast. They share `extractPlaneRef` and `verifySignature`, nothing
else.

## Error handling

| Failure | Behavior |
|---------|----------|
| HMAC verification fails | 401, no broadcast. Existing behavior. |
| `release_broadcasts` insert returns no row (replay) | 204, no fan-out. |
| `fetchCommits` GitHub API call fails | Build the note with an empty commit list and a `(commits unavailable)` line. Still broadcast — the "PR merged" signal is itself the value. |
| One bot's `sendMessage` returns non-2xx | Log, continue with others. |
| `dev_bots` empty (no team paired) | Log `[release] no active bots`, return 202. |

We deliberately do **not** wrap the broadcast in a transaction with
the insert — if the insert succeeds and the broadcast fails on every
bot, we'd rather take the small drop than re-broadcast on the next
delivery. GitHub's at-least-once webhook delivery makes the second
case (re-broadcast) more visible/annoying than a missed message.

## Testing

`tests/server/release-notes.test.js`:
- `buildReleaseNote` formats title, author, stats, commits, truncation.
- `buildReleaseNote` includes Plane URL when planeRef is sequence-style,
  omits when UUID-style.
- `recordBroadcast` returns `inserted` first time, `replay` second time.
- `fanOut` calls `sendMessage` once per active bot, skips bots with
  `owner_tg_user_id IS NULL`, swallows individual failures.

`tests/server/webhooks-github-merged.test.js`:
- `closed + merged=true` → `broadcastRelease` called once.
- `closed + merged=false` → no broadcast, 204.
- `closed + merged=true` delivered twice → broadcast called once
  (second call short-circuits via `recordBroadcast` returning replay).
- `opened` event after this change still dispatches
  `merge-coordinator` — regression guard.
- HMAC mismatch on a `closed+merged` event → 401, no broadcast.

Mocks:
- `dev-bots.listActive` returns a fixed fixture.
- `fetch` (global) is stubbed for both GitHub `/commits` and Telegram
  `sendMessage`.

## Configuration

No new env vars. Reuses:
- `GITHUB_WEBHOOK_SECRET` (HMAC, already present).
- `GITHUB_TOKEN` (for `fetchCommits` — already present in deploy.yml).
- Per-bot tokens live in `dev_bots.bot_token`.

## Rollout

1. Merge `feat/wi-7096cee4-…` first (the merge-coordinator branch this
   builds on). The webhook endpoint must already be live.
2. Apply migration `008-release-broadcasts.sql` (idempotent —
   `IF NOT EXISTS`).
3. Deploy `devpanel` container. The webhook auto-picks up the new
   `closed` branch.
4. Smoke-test by closing a tiny PR with `merged=true` (or by replaying
   a webhook delivery from the GitHub UI). All paired bots should
   receive the note within a couple of seconds.

## Open questions

None blocking. If the team grows past ~10 active bots and the fan-out
loop starts taking >2s, move it to a BullMQ job. Premature for now.
