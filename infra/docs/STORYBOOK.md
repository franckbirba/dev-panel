# Storybook sync

Stories live in each project repo under `stories/`. On every push to
main, the reusable `sync-stories.yml` workflow rsyncs them into
`/home/deploy/dev-panel/storybook-stories/<project-slug>/` on the
services VPS. The `storybook` container bind-mounts that folder
read-only at `/stories`, so new content appears on next Storybook
reload — no container restart needed.

## Required GitHub secrets

On the dev-panel repo (already set):

- `VPS_SSH_KEY` — private key for `deploy@services-vps`. Reused by the
  sync workflow.
- `VPS_HOST` — services VPS hostname or IP.

On other caller repos (zeno, edms, candidat, …):

- `VPS_SSH_KEY` — same deploy key (or a narrower per-project key you
  authorized separately on the VPS).
- `VPS_HOST` — same hostname.
- `VPS_SSH_FINGERPRINT` *(optional, recommended)* — output of
  `ssh-keyscan -H <host>`. When set, pins the host key. When unset, the
  workflow falls back to `ssh-keyscan` and logs a warning (first-run
  MITM window).

## Overriding defaults

The reusable workflow accepts two optional secrets for callers who want
to isolate their sync to a different user or base path on the VPS:

- `SYNC_USER` — defaults to `deploy`.
- `SYNC_BASE_PATH` — defaults to `/home/deploy/dev-panel/storybook-stories`.

Per-project subdirectories are created automatically on first sync.

## Why no dedicated `storybook-sync` user?

Earlier designs ran a restricted `storybook-sync` system user with
`rrsync` `command=` pins per project. That required `sudo` on the VPS
to create the user, which Franck doesn't routinely have at hand. Since
the studio is a single principal (Franck + his CI), the deploy key is
already the trust boundary — adding a second restricted user gave
no real isolation. The simpler setup is: one deploy key, one bind-mount
folder, done.

If the studio ever adds a second principal and key isolation becomes
valuable, re-introduce a dedicated system user and point `SYNC_USER`
at it via repo secret. The workflow is ready for that.
