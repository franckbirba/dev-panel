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
// For *active* jobs we POST `<WORKER_API>/kill/<job_id>` so the worker
// can interrupt the running `claude -p` subprocess. For waiting / delayed
// / completed / failed jobs we just `job.remove()`.
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
      // Kill the running subprocess by asking the worker. The worker
      // listens on a per-host HTTP endpoint; from devpanel-api this hits
      // the local-only loopback the worker is configured to expose, or
      // the WORKER_API env override. Failure to reach the worker is
      // surfaced explicitly — we don't pretend the kill succeeded.
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
            message: `Worker /kill returned ${resp.status}.`,
          };
        }
        return {
          job_id,
          action: 'killed',
          ok: true,
          prev_state: prevState,
          message: `Kill signal sent to worker for ${job_id}.`,
        };
      } catch (err) {
        return {
          job_id,
          action: 'kill_unreachable',
          ok: false,
          prev_state: prevState,
          message: `Cannot reach worker API at ${WORKER_API}: ${err.message}`,
        };
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
