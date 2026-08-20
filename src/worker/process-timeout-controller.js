// src/worker/process-timeout-controller.js
//
// Engine contract §5 — stall detection + wall-clock timeout enforcement for
// a single spawned agent process. Owns exactly one job's kill lifecycle:
//
//   - stall: no driver event (tool call, text, any stream chunk) for
//     `stallMs` (default 5 min) → kill, reason='stall'.
//   - wall-clock: the process has run longer than `wallClockMs` (per-role,
//     from timeout-policy.js) → kill, reason='wall_clock'.
//   - kill = SIGTERM to the process GROUP, `graceMs` (default 30s) of
//     grace, then SIGKILL to the group if it hasn't exited.
//
// Deliberately decoupled from `timeout-policy.js` (which only computes the
// numbers) and from `child_process` specifics beyond `pid` + `kill()` +
// `on('exit', ...)`, so it can be unit-tested with a fake process and fake
// timers instead of a real `claude -p` spawn.
//
// The worktree is NEVER touched by this controller — killing the process
// leaves the worktree in place for the rescue path (automation.js), exactly
// as the contract requires ("worktree conservé pour rescue").

/**
 * @typedef {object} FakeableProcess
 * @property {number} pid
 * @property {(signal: string) => void} kill
 * @property {(event: 'exit', cb: () => void) => void} once
 */

/**
 * @param {object} opts
 * @param {FakeableProcess} opts.proc - the spawned child process (or a
 *   process-group-equivalent handle exposing pid/kill/once('exit')).
 * @param {number} opts.wallClockMs - wall-clock ceiling for this role.
 * @param {number} [opts.stallMs] - stall detection window.
 * @param {number} [opts.graceMs] - SIGTERM→SIGKILL grace period.
 * @param {(info: { reason: 'stall'|'wall_clock' }) => void} opts.onKill -
 *   called ONCE, synchronously with the kill decision, before SIGTERM is
 *   sent. Callers use this to record the classification (agent_failure,
 *   reason=stall|timeout) before the process actually dies.
 * @param {(fn: () => void, ms: number) => any} [opts.setTimeoutFn]
 * @param {(handle: any) => void} [opts.clearTimeoutFn]
 * @param {() => number} [opts.now]
 * @param {(pid: number, signal: string) => void} [opts.killGroupFn] -
 *   defaults to `process.kill(-pid, signal)` (negative pid = process
 *   group on POSIX). Injectable for tests / non-POSIX hosts.
 */
export function createProcessTimeoutController({
  proc,
  wallClockMs,
  stallMs = 5 * 60 * 1000,
  graceMs = 30 * 1000,
  onKill,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
  killGroupFn = defaultKillGroup,
}) {
  let lastEventAt = now();
  let killed = false;
  let stopped = false;

  let stallCheckHandle = null;
  let wallClockHandle = null;
  let killGraceHandle = null;

  // Stall is checked on a poll interval (a quarter of the window, min 1s)
  // rather than reset-on-every-event with a single timer, because the
  // stream parser can emit many events per second under load — rescheduling
  // a timer that often is wasteful. A poll is simpler to reason about and
  // still detects stall within one poll interval of the deadline.
  const pollIntervalMs = Math.max(1000, Math.floor(stallMs / 4));

  function fireKill(reason) {
    if (killed || stopped) return;
    killed = true;
    clearAllTimers();
    try { onKill?.({ reason }); } catch { /* best-effort */ }
    doKill();
  }

  function doKill() {
    try {
      killGroupFn(proc.pid, 'SIGTERM');
    } catch { /* process may already be gone */ }
    let exited = false;
    const onExit = () => { exited = true; if (killGraceHandle) clearTimeoutFn(killGraceHandle); };
    try { proc.once('exit', onExit); } catch { /* best-effort */ }
    killGraceHandle = setTimeoutFn(() => {
      if (exited) return;
      try { killGroupFn(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, graceMs);
  }

  function clearAllTimers() {
    if (stallCheckHandle) clearTimeoutFn(stallCheckHandle);
    if (wallClockHandle) clearTimeoutFn(wallClockHandle);
    stallCheckHandle = null;
    wallClockHandle = null;
  }

  function pollStall() {
    if (killed || stopped) return;
    if (now() - lastEventAt >= stallMs) {
      fireKill('stall');
      return;
    }
    stallCheckHandle = setTimeoutFn(pollStall, pollIntervalMs);
  }

  stallCheckHandle = setTimeoutFn(pollStall, pollIntervalMs);
  wallClockHandle = setTimeoutFn(() => fireKill('wall_clock'), wallClockMs);

  return {
    /** Call on every driver event (tool call, stream chunk, text). */
    recordEvent() {
      lastEventAt = now();
    },
    /** Call when the process exits normally — stops all timers. */
    stop() {
      stopped = true;
      clearAllTimers();
      if (killGraceHandle) clearTimeoutFn(killGraceHandle);
    },
    /** True once a kill has been initiated (stall or wall-clock). */
    isKilled() {
      return killed;
    },
  };
}

function defaultKillGroup(pid, signal) {
  // Negative pid targets the whole process group on POSIX when the child
  // was spawned with `detached: true` (see src/worker/index.js spawnAgent).
  // Falls back to a plain kill if the group kill fails (e.g. pid already
  // reaped, or running on a platform without process groups).
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}
