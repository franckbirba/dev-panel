// src/worker/worker-control.js
//
// Engine contract §7 — cancel channel. Redis pub/sub on channel
// `worker:control`, replacing the socket.io `admin:command` stub that used
// to sit at agent-hub-client.js:71 ("TODO: wire to worker control
// surface"). Redis is already shared infrastructure between the API and
// the worker (BullMQ itself runs on it), so a pub/sub channel needs no new
// network path, no new auth token, and works even if the socket.io hub
// connection is down — cancel must be reliable independently of the
// dashboard's live-event transport.
//
// Message shape published on `worker:control`:
//   { type: 'cancel', job_id: '<bullmq job id>', requested_at: <ms> }
//
// The channel is intentionally generic (`type` field) so future control
// messages (pause, set_autonomy) can reuse it without a new channel.
//
// Publisher side (API / capabilities / dashboard) calls publishCancel().
// Subscriber side (the worker process) calls subscribeWorkerControl() once
// at boot with a handler that receives { type, job_id, ... } messages and
// decides what to do (kill the matching activeProcesses entry).
//
// Both sides accept an injectable ioredis-like client so tests don't need a
// real Redis server — see tests/worker/worker-control.test.js.

export const WORKER_CONTROL_CHANNEL = 'worker:control';

/**
 * Publish a cancel request for a BullMQ job id. Fire-and-forget-friendly:
 * returns the number of subscribers Redis delivered to (0 if no worker is
 * currently subscribed — the caller should still treat this as "request
 * sent", since a worker that (re)connects later won't see missed messages;
 * that's why cancel_job.js keeps the HTTP /kill/:jobId fallback for the
 * case where pub/sub delivery can't be confirmed).
 *
 * @param {object} client - ioredis-like client with `.publish(channel, message)`
 * @param {string} jobId
 * @returns {Promise<number>} subscriber count Redis reports it delivered to
 */
export async function publishCancel(client, jobId) {
  const message = JSON.stringify({
    type: 'cancel',
    job_id: String(jobId),
    requested_at: Date.now(),
  });
  return client.publish(WORKER_CONTROL_CHANNEL, message);
}

/**
 * Subscribe to the worker:control channel and invoke `handler` for every
 * well-formed message. Malformed JSON is logged and dropped — a bad message
 * must never crash the worker's control-plane listener.
 *
 * ioredis subscriber connections can ONLY issue pub/sub commands once
 * `.subscribe()` has been called — callers must pass a DEDICATED connection
 * (not the shared BullMQ connection), matching ioredis's own documented
 * constraint.
 *
 * @param {object} client - ioredis-like client with `.subscribe` and `.on('message', ...)`
 * @param {(msg: { type: string, job_id?: string, requested_at?: number }) => void} handler
 * @returns {Promise<void>}
 */
export async function subscribeWorkerControl(client, handler) {
  await client.subscribe(WORKER_CONTROL_CHANNEL);
  client.on('message', (channel, raw) => {
    if (channel !== WORKER_CONTROL_CHANNEL) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      console.warn(`[worker-control] malformed message on ${WORKER_CONTROL_CHANNEL}: ${err.message}`);
      return;
    }
    if (!msg || typeof msg !== 'object' || !msg.type) return;
    try {
      handler(msg);
    } catch (err) {
      console.warn(`[worker-control] handler threw for message type=${msg.type}: ${err.message}`);
    }
  });
}

/**
 * Build the cancel handler used by the worker process: given the live
 * `activeProcesses` map (jobId -> { process, startedAt }), kill the
 * matching process group on a cancel message. No-op (never throws) when the
 * job isn't active locally — either it already finished, or it's running on
 * a different worker instance, which is expected in a multi-worker fleet
 * (every worker subscribes to the same channel and only the one holding the
 * job acts).
 *
 * @param {Map<string, {process: {pid:number,kill:Function}, startedAt:number}>} activeProcesses
 * @param {(pid: number, signal: string) => void} [killGroupFn]
 * @returns {(msg: object) => void}
 */
export function createCancelHandler(activeProcesses, killGroupFn = defaultKillGroup) {
  return function handleControlMessage(msg) {
    if (msg.type !== 'cancel' || !msg.job_id) return;
    const entry = activeProcesses.get(String(msg.job_id));
    if (!entry) return; // not ours — fine in a multi-worker fleet
    console.log(`[worker-control] cancel received for job ${msg.job_id}, sending SIGTERM to process group`);
    killGroupFn(entry.process.pid, 'SIGTERM');
  };
}

function defaultKillGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}
