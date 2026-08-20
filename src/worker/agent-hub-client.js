// src/worker/agent-hub-client.js
// Socket.io client that connects from the worker (hetzner-vps) to the
// services-API hub. Emits live events for every workflow / job_log write.
//
// Why we duplicate-emit
// ---------------------
// jobs-log.js and workflow-instances.js both broadcast on the local
// in-process SSE channel (sse.js). That works on the API side. On the
// worker side those modules also fire — so this client subscribes to its
// own emitter (well, calls the connection helper directly) and forwards
// to the hub. The dual write keeps Postgres durability AND adds real-time
// transport. Postgres is no longer the bus, it's the ledger.
//
// Auth: AGENT_HUB_TOKEN shared with services-VPS (.env.production on
// both). AGENT_HUB_URL points the worker at the services VPS.

import { io as ioClient } from 'socket.io-client';
import { createCancelHandler } from './worker-control.js';

let socket = null;
let queue = []; // events buffered while disconnected

// Engine contract §7 — the Redis pub/sub channel (worker-control.js) is now
// the primary cancel path (see subscribeWorkerControl() wired at boot in
// index.js). This socket.io 'admin:command' listener is kept as a SECOND
// delivery path over the existing hub connection — belt-and-braces, since
// the hub is already open for agent:event traffic and cancel is the one
// command type where "arrived twice, killed a job that's already gone" is
// harmless (createCancelHandler no-ops when the job isn't in
// activeProcesses) but "never arrived" is not. Set via wireCancelHandler()
// so this module doesn't import ./index.js (circular).
let _cancelHandler = null;
export function wireCancelHandler(activeProcesses) {
  _cancelHandler = createCancelHandler(activeProcesses);
}

const HOST = process.env.HOSTNAME || process.env.AGENT_HOST || 'agents-host';
const AGENT_ID = process.env.AGENT_ID || `worker-${HOST}-${process.pid}`;

export function connectAgentHub({
  url = process.env.AGENT_HUB_URL,
  token = process.env.AGENT_HUB_TOKEN,
} = {}) {
  if (socket) return socket;
  if (!url || !token) {
    console.warn('[agent-hub-client] AGENT_HUB_URL or AGENT_HUB_TOKEN not set — running offline');
    return null;
  }
  socket = ioClient(url, {
    path: '/agents/socket.io',
    auth: { token },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000,
    transports: ['websocket'], // skip long-poll fallback — we control both ends
  });

  socket.on('connect', () => {
    console.log('[agent-hub-client] connected to', url, 'as', AGENT_ID);
    socket.emit('agent:hello', {
      agent_id: AGENT_ID,
      host: HOST,
      version: process.env.npm_package_version || 'dev',
    });
    // Flush any events that were buffered while offline.
    while (queue.length > 0) {
      const ev = queue.shift();
      socket.emit('agent:event', ev);
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('[agent-hub-client] disconnected:', reason);
  });

  socket.on('connect_error', (err) => {
    console.warn('[agent-hub-client] connect_error:', err.message);
  });

  // Admin commands flow back here so the worker can react (cancel a
  // running spawn, change autonomy mid-flight, etc.). Cancel is now wired
  // to the same handler the Redis worker:control subscriber uses
  // (wireCancelHandler() below); other command types still just log until
  // there's a concrete use case.
  socket.on('admin:command', (cmd) => {
    console.log('[agent-hub-client] admin:command', cmd);
    if (cmd?.type === 'cancel' && _cancelHandler) {
      _cancelHandler({ type: 'cancel', job_id: cmd.payload?.job_id });
    }
  });

  return socket;
}

export function emitAgentEvent(type, payload = {}) {
  const ev = { type, ...payload, _agent_id: AGENT_ID, _ts: Date.now() };
  if (!socket || !socket.connected) {
    // Buffer up to 200 events while disconnected; drop the oldest beyond
    // that. Worker restart wipes the buffer — Postgres is still the
    // durable record.
    queue.push(ev);
    if (queue.length > 200) queue.shift();
    return false;
  }
  socket.emit('agent:event', ev);
  return true;
}

export function disconnectAgentHub() {
  if (socket) {
    try { socket.emit('agent:goodbye', { reason: 'shutdown' }); } catch { /* ignore */ }
    try { socket.disconnect(); } catch { /* ignore */ }
    socket = null;
  }
}
