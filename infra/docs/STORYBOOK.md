# Storybook sync

Required GitHub secrets on the dev-panel repo and every caller repo:

- `STORYBOOK_SYNC_SSH_KEY` — private key for the `storybook-sync` user on
  the services VPS, pinned to the project's subdir via rrsync.
- `VPS_HOST` — already set for core deploy; reused here.
- `STORYBOOK_SYNC_FINGERPRINT` *(optional but recommended in production)* —
  the line printed by `ssh-keyscan -H <host>`. When set, the sync workflow
  pins the host key and skips the first-run MITM window. When unset, the
  workflow falls back to `ssh-keyscan` and prints a warning in the job log.

The `storybook-sync` user is provisioned once by
`infra/scripts/bootstrap/storybook-sync-user.sh` (run as root on the
services VPS). Follow the HELP text it prints for per-project onboarding
(generate a keypair, append the public key with `command="/usr/bin/rrsync
-wo /var/lib/devpanl/storybook-stories/<project>"` restriction, create the
subdir).

The reusable sync workflow lives at `.github/workflows/sync-stories.yml`
and is called by `deploy.yml` for dev-panel's own `stories/` and
`stories-shared/`. Other repos call the same workflow via `workflow_call`
with `project-slug: <their-slug>`.
