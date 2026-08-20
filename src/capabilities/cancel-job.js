import { z } from 'zod';

// Cancel a BullMQ job — capability wrapper around the raw `cancel_job`
// MCP tool. Carded by `CancelJobCard` in the dashboard chat so the
// confirmation surfaces with a chip, instead of as raw JSON.
//
// Resolution path mirrors `routes-commands.js#cancel-job` + the raw MCP
// tool at `src/mcp/server.js:1105`. Lookup spans every BullMQ queue
// (waiting/delayed/active/etc.) — `dispatch_work_item` enqueues to the
// `agents` queue today, but other workflows may add their own and we
// don't want this verb to silently miss them.
//
// Engine contract §7 — for *active* jobs the PRIMARY cancel path is now
// Redis pub/sub on `worker:control` (src/worker/worker-control.js): every
// worker instance subscribes and kills the matching process group if it
// owns the job. This replaces the old socket.io-hub-only stub and, more
// importantly, doesn't require services-API → agents-host HTTP
// reachability — Redis is already shared infra both sides depend on for
// BullMQ itself. `POST <WORKER_API>/kill/<job_id>` remains as a FALLBACK,
// tried when the pub/sub publish itself fails outright (Redis unreachable)
// so an operator still has a way to kill a job on a known single-worker
// deployment. Cancel is always accepted on a live job; on an already
// terminal job the queue lookup below returns not_found / removed, which
// is the idempotent no-op the contract requires.
//
// For waiting / delayed / completed / failed jobs we just `job.remove()`.
//
// The capability name *is* `cancel_job`, so there is no alias to register
// — the raw `cancel_job` registration in `src/mcp/server.js` has been
// removed in favour of this capability. The Shelly SOUL.md verb table
// (`"kill" / "stop" → cancel_job`) continues to work; the tool name on
// the wire is unchanged.

const WORKER_API = process.env.WORKER_API || 'http://localhost:3099';

export const cancelJob = {
  name: 'cancel_job',
  description:
    'Cancel a BullMQ job. Removes waiting/delayed jobs directly; sends a kill signal to the worker for active jobs. Use when Franck says "kill <job_id>" / "stop <job_id>" / clicks the Kill chip on a fleet row.',
  paramSchema: z.object({
    job_id: z.string().describe('BullMQ job id'),
  }),
  renderHint: 'JobCancellation',
  async handler({ job_id }) {
    const { getQueue, QUEUES } = await import('../server/bullmq.js');
    let found = null;
    let prevState = null;
    for (const name of Object.values(QUEUES)) {
      const queue = getQueue(name);
      const job = await queue.getJob(job_id);
      if (job) {
        found = job;
        prevState = await job.getState();
        break;
      }
    }
    if (!found) {
      return {
        job_id,
        action: 'not_found',
        ok: false,
        message: `Job ${job_id} not found in any queue.`,
      };
    }

    if (prevState === 'active') {
      // Primary path (§7): publish on the worker:control Redis channel.
      // Every worker instance is subscribed; whichever one owns this job_id
      // in its activeProcesses map kills the process group. This works
      // even when the API and the worker aren't directly HTTP-reachable —
      // they already share Redis for BullMQ itself.
      try {
        const { getSharedRedisConnection } = await import('../server/bullmq.js');
        const { publishCancel } = await import('../worker/worker-control.js');
        await publishCancel(getSharedRedisConnection(), job_id);
        return {
          job_id,
          action: 'killed',
          ok: true,
          prev_state: prevState,
          message: `Cancel published on worker:control for ${job_id}.`,
        };
      } catch (pubErr) {
        // Fallback: local HTTP kill. Only reachable when the caller and the
        // worker share a host/tunnel (WORKER_API), but better than nothing
        // when Redis itself is the thing that's down.
        try {
          const resp = await fetch(`${WORKER_API}/kill/${encodeURIComponent(job_id)}`, {
            method: 'POST',
            signal: AbortSignal.timeout(5000),
          });
          if (!resp.ok) {
            return {
              job_id,
              action: 'kill_failed',
              ok: false,
              prev_state: prevState,
              message: `worker:control publish failed (${pubErr.message}) and worker /kill returned ${resp.status}.`,
            };
          }
          return {
            job_id,
            action: 'killed',
            ok: true,
            prev_state: prevState,
            message: `worker:control publish failed (${pubErr.message}); fell back to HTTP kill for ${job_id}.`,
          };
        } catch (httpErr) {
          return {
            job_id,
            action: 'kill_unreachable',
            ok: false,
            prev_state: prevState,
            message: `Cannot cancel ${job_id}: worker:control publish failed (${pubErr.message}) and worker API unreachable at ${WORKER_API} (${httpErr.message}).`,
          };
        }
      }
    }

    // Non-active states: remove the job from the queue directly.
    await found.remove();
    return {
      job_id,
      action: 'removed',
      ok: true,
      prev_state: prevState,
      message: `Removed ${job_id} (was ${prevState}).`,
    };
  },
};
