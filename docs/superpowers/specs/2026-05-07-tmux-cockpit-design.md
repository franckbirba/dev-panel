# tmux cockpit for devpanl + Shelly

**Status:** approved design, ready for implementation plan
**Author:** Franck + Claude
**Date:** 2026-05-07

## Goal

Two tmux launchers — one local, one remote — that give Franck a consistent, low-ceremony workspace for working on dev-panel and observing Shelly.

- **Local cockpit:** multi-window tmux on Franck's Mac for day-to-day dev work on the dev-panel repo.
- **Remote observation:** a single-window, multi-pane tmux on `hetzner-vps` that surfaces Shelly *plus* her substrate (worker, telegram-multi health, redis) when SSHing in to debug.

Neither launcher touches the existing `shelly.service` / `tmux -L deploy -s shelly` runtime. Observation is read-only.

## Non-goals

- No tmux plugin manager (no tpm). Keeps the VPS install footprint at zero.
- No theme framework. Status bar is plain.
- No global `~/.tmux.conf` rewrite. The cockpit loads its own config via `tmux -f`, so any other tmux Franck uses is untouched.
- No auto-start on shell login. The launchers run on demand.
- No new systemd units. The remote launcher is just a script run via SSH.
- Not renaming, restarting, or replacing `shelly.service` or its tmux session.

## Local cockpit

### Invocation

```bash
./scripts/tmux-cockpit.sh
```

Idempotent: if a tmux session named `devpanl` exists, attach to it. Otherwise create and attach.

Uses a project-local config: `tmux -L devpanl -f scripts/tmux/devpanl.conf …`. The custom socket name (`-L devpanl`) ensures the cockpit's config doesn't bleed into a vanilla `tmux` invocation.

### Session layout

Session name: `devpanl`. Six windows, indexed from 1 (configured in `devpanl.conf` via `base-index 1`).

| # | Window name | Layout | Contents |
|---|-------------|--------|----------|
| 1 | `api` | single pane | `node bin/dev-panel.js serve`, wrapped in a tiny `while true; …; sleep 1; done` so a crash leaves a visible exit message and auto-restarts. |
| 2 | `dash` | single pane | `npm run dev:dashboard` (Vite). |
| 3 | `worker` | horizontal split | **top:** shell in repo root with `# tail -F …/worker.log` printed as a hint comment, ready for Franck to run when needed. **bottom:** `redis-cli -h 127.0.0.1 monitor` (or a shell with the command pre-loaded as a hint, in case local redis isn't running). |
| 4 | `mcp` | horizontal split | **top:** shell in `src/mcp/`. **bottom:** shell in repo root with `# tail -F …/mcp.log` as a hint comment. |
| 5 | `shelly` | single pane | `ssh hetzner-vps 'su - deploy -c "tmux -L deploy attach -t shelly -r"'` — read-only attach to the live Shelly. `-r` prevents accidental keystrokes into Claude. Detach with `Ctrl-b d` returns to the local tmux. |
| 6 | `git` | single pane | Shell in repo root, no command pre-run. Scratch space for git, edits, ad-hoc commands. |

The launcher creates each window in order, then `select-window -t devpanl:1` so attach lands on `api`.

### Why "hint comments" instead of auto-running everything

Worker and MCP server tails depend on processes Franck may or may not want running locally at any given moment. Auto-starting them would either block (no log file yet → `tail -F` waits) or silently fail. Printing the suggested command as a comment in the pane gives Franck a one-keystroke recall without committing to a process he didn't ask for.

### Config file: `scripts/tmux/devpanl.conf`

Minimal. Only what the cockpit needs:

```tmux
set -g default-terminal "screen-256color"
set -g base-index 1
setw -g pane-base-index 1
set -g mouse on
set -g history-limit 50000

# Status bar — subtle, informative
set -g status-style bg=default,fg=cyan
set -g status-left "[#S] "
set -g status-right "%H:%M  #h"
set -g status-interval 5

# Keep prefix as Ctrl-b (don't surprise muscle memory)
```

No prefix change, no key remaps. Anything Franck wants beyond this lives in his personal `~/.tmux.conf` (which this config does NOT load — `-f` replaces, doesn't extend).

## Remote observe (hetzner-vps)

### Invocation

From Franck's Mac:

```bash
ssh hetzner-vps 'su - deploy -c "/home/deploy/projects/dev-panel/scripts/tmux-observe.sh"'
```

Idempotent: attach to `observe` if it exists, else create. Uses the *default* tmux socket on the VPS (no `-L`), so it sits alongside `tmux -L deploy -s shelly` without colliding.

The session name `observe` is deliberately distinct from `shelly`, which is reserved for the live Claude session under socket `-L deploy`.

### Pane layout

Single window named `observe`, four panes:

```
+------------------------+----------------------+
|                        |                      |
|  Shelly (read-only)    |  journalctl -fu      |
|  tmux -L deploy        |  shelly.service      |
|  attach -t shelly -r   |                      |
|  (top-left, big)       |                      |
|                        |                      |
+------------------------+----------------------+
|                        |                      |
|  journalctl -fu        |  watch -n 5 health   |
|  devpanel-worker       |  (telegram-multi +   |
|  .service              |   redis ping)        |
|                        |                      |
+------------------------+----------------------+
```

Achieved with:

```bash
tmux new-session -d -s observe -n observe \
  "tmux -L deploy attach -t shelly -r"
tmux split-window -h -t observe:observe \
  "journalctl -fu shelly.service"
tmux split-window -v -t observe:observe.1 \
  "journalctl -fu devpanel-worker.service"
tmux split-window -v -t observe:observe.2 \
  "watch -n 5 'jq . /home/deploy/logs/telegram-multi/health.json 2>/dev/null; echo; redis-cli -h 10.0.0.2 ping'"
tmux select-pane -t observe:observe.1
tmux attach -t observe
```

Pane indices follow tmux's split order — the script doesn't rely on absolute indices except for the final `select-pane`.

### Read-only enforcement

The Shelly pane uses `attach -t shelly -r`. Even if Franck typo-paste-bombs into that pane, nothing reaches the Claude session. To interact, he detaches with `Ctrl-b d` and re-attaches without `-r` from a different shell — explicit choice, not accidental.

## Files added

```
scripts/tmux-cockpit.sh           # local launcher (Mac)
scripts/tmux-observe.sh           # remote launcher (hetzner-vps)
scripts/tmux/devpanl.conf         # local cockpit tmux config
```

`tmux-observe.sh` is shipped to the VPS by the existing `scripts/deploy-agents.sh` flow. We extend that script's rsync include list to cover `scripts/tmux-observe.sh` (one line). No new deploy mechanism.

## Idempotency

Both launchers follow the same shape:

```bash
SESSION="devpanl"  # or "observe"
if tmux -L "$SOCKET" has-session -t "$SESSION" 2>/dev/null; then
  exec tmux -L "$SOCKET" attach -t "$SESSION"
fi
# … create session, then attach
```

Re-running never spawns duplicates and never recreates panes inside an existing session.

## Failure modes considered

- **VPS rebooted, `tmux -L deploy -s shelly` not running yet** → window 5 / top-left pane shows tmux's "no sessions" error and exits. The cockpit window stays; Franck can re-run after `systemctl restart shelly.service`. We do not auto-restart Shelly from the observer.
- **Local redis not running** → `redis-cli monitor` exits with a connection error, leaves the pane at a shell prompt. Acceptable; loud failure, no zombie process.
- **Local Vite port already bound** (window 2) → Vite errors and exits. Pane shows the message; Franck kills the other process or skips the dash window.
- **SSH config missing `hetzner-vps` host alias** → window 5 fails fast with "Could not resolve hostname". Documented in the cockpit script's header comment as a prerequisite.
- **`tmux` not installed on the VPS** → `tmux-observe.sh` fails fast. Documented prerequisite; tmux is already a hard dependency of `shelly.service` so this is theoretical.

## Out of scope (explicit)

- Power-user keybindings (split-h, split-v shortcuts, etc.) — Franck adds those to his personal config if he wants them; cockpit stays minimal.
- A "molly" cockpit. Molly doesn't exist as a runtime yet (memory: `devpanel_status.md` — v3 agents to-do). When she does, this design extends with a sibling launcher; we don't pre-build for it.
- Tmuxinator/teamocil-style YAML configs. Bash scripts are the shortest path and have zero install footprint.
- Logging / recording sessions (`tmux pipe-pane`, `asciinema`). Not asked for.

## Acceptance criteria

1. `./scripts/tmux-cockpit.sh` from the dev-panel repo on Franck's Mac:
   - First run: creates session `devpanl` with 6 windows in the documented layout, attaches to window 1 (`api`).
   - Second run while session exists: attaches to the existing session, does not spawn duplicate windows.
2. `ssh hetzner-vps 'su - deploy -c "/home/deploy/projects/dev-panel/scripts/tmux-observe.sh"'`:
   - First run: creates session `observe` with one window, four panes in the documented layout. Top-left pane shows the live Shelly read-only.
   - Second run while session exists: attaches to existing.
3. The Shelly observation pane is read-only — keystrokes do not reach the Claude session.
4. `scripts/deploy-agents.sh` deploys `tmux-observe.sh` to `/home/deploy/projects/dev-panel/scripts/` on hetzner-vps with executable bit set.
5. Neither launcher modifies `~/.tmux.conf`, the `-L deploy` socket, or any systemd unit.
