# tmux Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two tmux launchers — a local multi-window cockpit on Franck's Mac and a read-only observation session on hetzner-vps — without touching `shelly.service`, `~/.tmux.conf`, or any systemd unit.

**Architecture:** Three plain bash/conf files under `scripts/`. The local cockpit uses a project-scoped tmux socket (`-L devpanl`) and a dedicated config file so it never collides with the user's global tmux. The remote observer uses the default tmux socket on the VPS, but a session name (`observe`) distinct from the live `-L deploy -s shelly` session. Both launchers are idempotent.

**Tech Stack:** bash, tmux 3.x, ssh, jq, redis-cli, journalctl. No new dependencies — all already present on both Mac (homebrew tmux 3.6a) and the VPS.

**Spec:** `docs/superpowers/specs/2026-05-07-tmux-cockpit-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `scripts/tmux-cockpit.sh` | Local launcher. Creates/attaches tmux session `devpanl` with 6 windows (api, dash, worker, mcp, shelly, git). Loads `scripts/tmux/devpanl.conf`. |
| `scripts/tmux/devpanl.conf` | Minimal tmux config used only by the cockpit. Status bar, mouse, history limit, base-index 1. No prefix change, no key remaps. |
| `scripts/tmux-observe.sh` | Remote launcher (runs on hetzner-vps as `deploy`). Creates/attaches tmux session `observe` with one window, four panes. |

The remote launcher reaches the VPS automatically because `scripts/deploy-agents.sh` runs `git pull --ff-only` on the VPS — no rsync change needed.

---

## Task 1: Create the cockpit tmux config

**Files:**
- Create: `scripts/tmux/devpanl.conf`

- [ ] **Step 1: Write the config file**

Create `scripts/tmux/devpanl.conf` with the following content:

```tmux
# scripts/tmux/devpanl.conf — config for the local devpanl cockpit.
# Loaded explicitly by scripts/tmux-cockpit.sh via `tmux -f`. Does NOT
# extend ~/.tmux.conf — `-f` replaces. Keep this file minimal.

set -g default-terminal "screen-256color"

# Windows and panes start at 1, not 0 — easier to reach on a keyboard.
set -g base-index 1
setw -g pane-base-index 1
set -g renumber-windows on

set -g mouse on
set -g history-limit 50000

# Status bar — subtle, informative. No theme deps.
set -g status-style bg=default,fg=cyan
set -g status-left "[#S] "
set -g status-right "%H:%M  #h"
set -g status-interval 5

# Prefix stays Ctrl-b — don't surprise muscle memory.
```

- [ ] **Step 2: Verify the config parses**

Run: `tmux -L devpanl-test -f scripts/tmux/devpanl.conf new-session -d -s probe 'sleep 1' && tmux -L devpanl-test kill-server`
Expected: no output, exit 0. If tmux prints a config error, fix the offending line.

- [ ] **Step 3: Commit**

```bash
git add scripts/tmux/devpanl.conf
git commit -m "feat(tmux): cockpit config for local devpanl session

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Create the local cockpit launcher

**Files:**
- Create: `scripts/tmux-cockpit.sh`

- [ ] **Step 1: Write the launcher**

Create `scripts/tmux-cockpit.sh` with the following content:

```bash
#!/usr/bin/env bash
# scripts/tmux-cockpit.sh — local devpanl cockpit launcher.
#
# Idempotent: attaches to an existing `devpanl` tmux session if one is
# running, otherwise creates a fresh one with 6 windows:
#   1 api    — node bin/dev-panel.js serve (auto-restart on crash)
#   2 dash   — npm run dev:dashboard (Vite)
#   3 worker — split: shell hint (top) + redis-cli monitor (bottom)
#   4 mcp    — split: shell in src/mcp (top) + shell hint (bottom)
#   5 shelly — read-only attach to live Shelly on hetzner-vps
#   6 git    — scratch shell at repo root
#
# Prerequisites:
#   - tmux 3.x on PATH
#   - SSH alias `hetzner-vps` configured (used by the shelly window)
#   - Run from anywhere — script resolves repo root via its own location.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCKET="devpanl"
SESSION="devpanl"
CONF="$REPO_ROOT/scripts/tmux/devpanl.conf"

TMUX="tmux -L $SOCKET -f $CONF"

# Already running? Attach and exit.
if $TMUX has-session -t "$SESSION" 2>/dev/null; then
  exec $TMUX attach -t "$SESSION"
fi

cd "$REPO_ROOT"

# Window 1: api — auto-restart loop so a crash leaves a visible message.
$TMUX new-session -d -s "$SESSION" -n api -c "$REPO_ROOT" \
  "while true; do node bin/dev-panel.js serve; echo; echo '[api exited \$?, restarting in 2s — Ctrl-C to stop]'; sleep 2; done"

# Window 2: dash
$TMUX new-window -t "$SESSION" -n dash -c "$REPO_ROOT" \
  "npm run dev:dashboard"

# Window 3: worker — horizontal split, hint comments in shells.
$TMUX new-window -t "$SESSION" -n worker -c "$REPO_ROOT"
$TMUX send-keys -t "$SESSION:worker" \
  "# tail -F path/to/worker.log    # uncomment when worker is running locally" Enter
$TMUX split-window -v -t "$SESSION:worker" -c "$REPO_ROOT" \
  "redis-cli -h 127.0.0.1 monitor || exec \$SHELL"

# Window 4: mcp — horizontal split.
$TMUX new-window -t "$SESSION" -n mcp -c "$REPO_ROOT/src/mcp"
$TMUX split-window -v -t "$SESSION:mcp" -c "$REPO_ROOT"
$TMUX send-keys -t "$SESSION:mcp.2" \
  "# tail -F path/to/mcp.log       # uncomment when MCP server is running locally" Enter

# Window 5: shelly — read-only attach to the live Shelly tmux on hetzner-vps.
$TMUX new-window -t "$SESSION" -n shelly \
  "ssh hetzner-vps 'su - deploy -c \"tmux -L deploy attach -t shelly -r\"' || exec \$SHELL"

# Window 6: git — plain shell.
$TMUX new-window -t "$SESSION" -n git -c "$REPO_ROOT"

# Land on api.
$TMUX select-window -t "$SESSION:api"

exec $TMUX attach -t "$SESSION"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/tmux-cockpit.sh`
Expected: no output, exit 0.

- [ ] **Step 3: Smoke-test creation (no attach)**

Goal: verify the session is built correctly without dragging the user into an interactive attach.

Run:
```bash
# Run the launcher in the background, then immediately list windows.
( scripts/tmux-cockpit.sh & ) ; sleep 2
tmux -L devpanl list-windows -t devpanl -F '#{window_index} #{window_name}'
```
Expected output (one per line, in this order):
```
1 api
2 dash
3 worker
4 mcp
5 shelly
6 git
```

If the names differ or windows are missing, debug the launcher. Note: the `api` and `dash` windows will actually try to start their commands — that's fine for the smoke test; the `while true` loop will print errors if the dependencies aren't available, but the window will still exist.

- [ ] **Step 4: Smoke-test idempotency**

Run: `scripts/tmux-cockpit.sh &` again immediately, then:
```bash
sleep 1
tmux -L devpanl list-windows -t devpanl | wc -l
```
Expected: `6` (no duplicate windows). If the count is more than 6, the launcher is creating panes inside the existing session — fix the `has-session` guard.

- [ ] **Step 5: Tear down the smoke-test session**

Run: `tmux -L devpanl kill-server`
Expected: exit 0. Re-run `tmux -L devpanl list-sessions` and confirm "no server running".

- [ ] **Step 6: Commit**

```bash
git add scripts/tmux-cockpit.sh
git commit -m "feat(tmux): local cockpit launcher (6-window devpanl session)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Create the remote observe launcher

**Files:**
- Create: `scripts/tmux-observe.sh`

- [ ] **Step 1: Write the launcher**

Create `scripts/tmux-observe.sh` with the following content:

```bash
#!/usr/bin/env bash
# scripts/tmux-observe.sh — read-only observation tmux on hetzner-vps.
#
# Runs as user `deploy` on the agents host. Creates (or attaches to) a
# tmux session `observe` on the default socket. The session has one
# window with four panes:
#   top-left   : tmux -L deploy attach -t shelly -r  (read-only Shelly)
#   top-right  : journalctl -fu shelly.service
#   bottom-left: journalctl -fu devpanel-worker.service
#   bottom-right: telegram-multi health.json + redis ping (watch -n 5)
#
# Invoke from your Mac:
#   ssh hetzner-vps 'su - deploy -c "/home/deploy/projects/dev-panel/scripts/tmux-observe.sh"'

set -euo pipefail

SESSION="observe"

# Already running? Attach and exit.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  exec tmux attach -t "$SESSION"
fi

# Pane 1 (top-left): live Shelly, read-only.
tmux new-session -d -s "$SESSION" -n observe \
  "tmux -L deploy attach -t shelly -r || exec \$SHELL"

# Pane 2 (top-right): Shelly's systemd log.
tmux split-window -h -t "$SESSION:observe" \
  "journalctl -fu shelly.service || exec \$SHELL"

# Pane 3 (bottom-left): worker log. Split off pane index 1 (top-left).
tmux split-window -v -t "$SESSION:observe.1" \
  "journalctl -fu devpanel-worker.service || exec \$SHELL"

# Pane 4 (bottom-right): telegram-multi health + redis ping.
# Split off pane index 2 (top-right, which is now pane 2 because pane 3
# took its slot only on the left column — tmux renumbers per split).
HEALTH_CMD='jq . /home/deploy/logs/telegram-multi/health.json 2>/dev/null; echo; redis-cli -h 10.0.0.2 ping 2>/dev/null'
tmux split-window -v -t "$SESSION:observe.2" \
  "watch -n 5 '$HEALTH_CMD' || exec \$SHELL"

# Land on the Shelly pane.
tmux select-pane -t "$SESSION:observe.1"

exec tmux attach -t "$SESSION"
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/tmux-observe.sh`
Expected: no output, exit 0.

- [ ] **Step 3: Static-check the script**

Run: `bash -n scripts/tmux-observe.sh`
Expected: no output, exit 0 (syntax OK). If `shellcheck` is installed, also run `shellcheck scripts/tmux-observe.sh` and address actionable warnings.

- [ ] **Step 4: Commit**

```bash
git add scripts/tmux-observe.sh
git commit -m "feat(tmux): remote observe launcher for hetzner-vps

Single-window, four-pane tmux session that surfaces live Shelly
(read-only), shelly.service log, worker log, and telegram-multi
health + redis ping side-by-side.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Verify deploy-agents picks up the new script

**Files:**
- Read-only: `scripts/deploy-agents.sh`

The deploy script runs `git pull --ff-only` on the VPS as user `deploy`, so any new file under `scripts/` is present after the next deploy with no rsync change. This task is a verification, not a code change.

- [ ] **Step 1: Confirm the deploy mechanism**

Run: `grep -n 'git pull' scripts/deploy-agents.sh`
Expected: a line like `su - deploy -c 'cd /home/deploy/projects/dev-panel && git pull --ff-only'`. If that line is missing or the path differs, stop and re-evaluate — the plan assumed `git pull` on the VPS handles the deploy.

- [ ] **Step 2: Confirm the script will be executable on the VPS**

`scripts/tmux-observe.sh` had `chmod +x` applied locally and the executable bit is preserved by git when committed. Verify:

Run: `git ls-files --stage scripts/tmux-observe.sh`
Expected: mode `100755` (executable). If it shows `100644`, run `chmod +x scripts/tmux-observe.sh && git add scripts/tmux-observe.sh && git commit --amend --no-edit`.

- [ ] **Step 3: No commit needed**

This task makes no code changes.

---

## Task 5: Acceptance test (manual, on real systems)

This task is a manual acceptance walkthrough. It verifies the spec's acceptance criteria end-to-end. It produces no commits — it exists as a checklist the implementer ticks off.

- [ ] **Step 1: Local cockpit, first run**

Run from the repo root: `./scripts/tmux-cockpit.sh`

Expected:
- A tmux session called `devpanl` opens.
- The attach lands on window 1, named `api`.
- `Ctrl-b w` shows windows 1–6 named `api`, `dash`, `worker`, `mcp`, `shelly`, `git`.
- Window 5 (`shelly`) opens an SSH session and ends up inside the live `tmux -L deploy -s shelly` on hetzner-vps. Typing in that pane has no effect on Claude (read-only).

- [ ] **Step 2: Local cockpit, idempotency**

While the cockpit is open, in a second Mac terminal run: `./scripts/tmux-cockpit.sh`

Expected: the second invocation attaches to the existing session. No duplicate windows. `Ctrl-b w` still shows exactly 6 windows.

- [ ] **Step 3: Detach and re-attach**

In the cockpit: `Ctrl-b d` to detach. Then run: `./scripts/tmux-cockpit.sh`

Expected: re-attaches cleanly to the same session.

- [ ] **Step 4: Tear down for next test**

Run: `tmux -L devpanl kill-server`

- [ ] **Step 5: Deploy the observe script**

Run: `./scripts/deploy-agents.sh`

Expected: the deploy completes successfully and `scripts/tmux-observe.sh` is now present at `/home/deploy/projects/dev-panel/scripts/tmux-observe.sh` on the VPS.

Verify:
```bash
ssh hetzner-vps 'ls -l /home/deploy/projects/dev-panel/scripts/tmux-observe.sh'
```
Expected: file exists, mode includes `x` for owner.

- [ ] **Step 6: Remote observer, first run**

Run from your Mac:
```bash
ssh hetzner-vps 'su - deploy -c "/home/deploy/projects/dev-panel/scripts/tmux-observe.sh"'
```

Expected:
- A tmux session `observe` opens with one window split into 4 panes.
- Top-left pane shows the live Shelly (read-only — no input goes through).
- Top-right pane streams `journalctl -fu shelly.service`.
- Bottom-left pane streams `journalctl -fu devpanel-worker.service`.
- Bottom-right pane refreshes telegram-multi `health.json` + a `PONG` from redis every 5s.

- [ ] **Step 7: Remote observer, idempotency**

Detach with `Ctrl-b d`, then re-run the same SSH command.

Expected: re-attaches to the existing session, panes intact, no duplicates.

- [ ] **Step 8: Confirm the live Shelly pane is read-only**

In the top-left pane of the remote observer, attempt to type "test\n". Watch the `[shelly]` Telegram channel.

Expected: nothing reaches Shelly. The `attach -r` flag prevents input from being sent.

- [ ] **Step 9: Confirm shelly.service is undisturbed**

Run: `ssh hetzner-vps 'systemctl is-active shelly.service && systemctl show -p ActiveEnterTimestamp shelly.service'`

Expected: `active`, with the same `ActiveEnterTimestamp` it had before this work started. If the timestamp moved, something restarted Shelly — investigate.

- [ ] **Step 10: Tear down**

In the remote tmux: `Ctrl-b :` then `kill-session` to end the `observe` session. The live Shelly under `-L deploy` is unaffected.

---

## Self-Review

**Spec coverage:**
- Local cockpit, 6 windows, hint-comment pattern → Task 2 ✓
- Cockpit config, no global tmux changes → Task 1 ✓
- Remote observe, 4-pane layout, read-only Shelly → Task 3 ✓
- Deploy mechanism via existing `deploy-agents.sh` → Task 4 ✓ (verifies `git pull` covers it; the spec said we'd "extend rsync" but `git pull` is even simpler and was already in place — plan corrects that)
- All acceptance criteria from the spec → Task 5 ✓
- Idempotency for both launchers → Tasks 2 step 4, 5 step 2, 5 step 7 ✓
- Read-only enforcement → Task 5 step 8 ✓

**Placeholder scan:** none. Every step has the actual file content or exact command and expected output.

**Type/name consistency:**
- Session names: cockpit = `devpanl`, observer = `observe` (consistent across spec and plan).
- Socket names: cockpit = `-L devpanl`, observer = default (consistent).
- Config path: `scripts/tmux/devpanl.conf` referenced identically in Task 1 (creation) and Task 2 (consumption).

**Spec correction logged:** the spec said `deploy-agents.sh` would gain an rsync include line; the plan instead relies on the existing `git pull` step on the VPS — same outcome, less code. This is mentioned in the spec coverage section above so the implementer doesn't get confused if they read the spec first.
