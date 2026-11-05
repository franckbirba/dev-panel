// src/server/agent-hub.js
// Socket.io hub on the services-API side. Agents (worker on hetzner-vps,
// ephemeral `claude -p` subprocesses) connect here and stream live events
// instead of routing everything through Postgres polling.
//
// Why this exists
// ---------------
// Until 2026-04-28 the architecture was:
//   worker → pg insert → postgres ← poll ← API ← SSE ← dashboard
// Every link in that chain added latency, and the poll on the API side meant
// the dashboard "Today" / "Agents" / "Fleet" views could be 10s+ behind the
// actual state of the world. The user (Franck, sole tenant) sent screenshots
// of jobs running on prod with the dashboard showing "0 active" and "4d ago"
// because the worker had silently stopped writing to a SQLite copy and the
// API was reading the stale copy. The visible bug was a stale read; the
// architectural bug was treating Postgres as the message bus.
//
// New shape
// ---------
//   worker.emit('agent:event', payload)   → io hub → broadcast() → dashboard SSE
//   admin.emit('admin:command', payload)  → io hub → forward to specific agent
// Postgres is still the durable record (we keep workflow_instances and
// agent_job_log writes for history) but it is no longer the transport.
//
// Auth
// ----
// Agent connections present `auth.token` matching env.AGENT_HUB_TOKEN. Token
// shared between services-VPS and agents-host (loaded from .env.production
// on both — the same shared-secret pattern used for redis + pg). No browser
// connects here; dashboards still receive events via the existing SSE
// fan-out (`broadcast` from sse.js).
//
// Channels
// --------
// 'agent:event'      — worker → hub (re-broadcast as workflow:changed,
//                      agent_step, etc. on the SSE pipe)
// 'admin:command'    — hub → agent (cancel, set_autonomy, kill_job)
// 'agent:hello'      — worker registration ({agent_id, host, version})
// 'agent:goodbye'    — clean disconnect (reason)

import { Server as IoServer } from 'socket.io';
import { randomUUID } from 'crypto';
import { 
  getAgentNode, 
  updateAgentNodeLastSeen, 
  getTaskToken, 
  claimTaskToken, 
  heartbeatTaskToken, 
  completeTaskToken,
  revokeTaskToken
} from './db.js';

let io = null;
const agents = new Map(); // socket.id → {agent_id, host, version, connected_at}
const taskChannels = new Map(); // task_id → {node_id, socket_id, token_id}

export function initAgentHub(httpServer, { token = process.env.AGENT_HUB_TOKEN } = {}) {
  if (io) return io;
  io = new IoServer(httpServer, {
    path: '/agents/socket.io',
    cors: { origin: false }, // hub is internal — never accept browser CORS
    pingTimeout: 30_000,
    pingInterval: 15_000,
  });

  io.use((socket, next) => {
    // Per-connection bearer token check. We accept the token via the
    // `auth: { token }` payload that socket.io-client supports natively.
    const provided = socket.handshake.auth?.token;
    if (!token) {
      // Guard against accidentally running an unauthenticated hub in prod.
      // If the env var isn't set we refuse all connections — better to fail
      // loud than silently accept any worker.
      console.error('[agent-hub] AGENT_HUB_TOKEN not set, refusing connection');
      return next(new Error('hub auth not configured'));
    }
    if (provided !== token) {
      return next(new Error('invalid agent token'));
    }
    next();
  });

  io.on('connection', async (socket) => {
    socket.on('agent:hello', (payload) => {
      agents.set(socket.id, {
        agent_id: payload?.agent_id || socket.id,
        host: payload?.host || 'unknown',
        version: payload?.version || null,
        connected_at: Date.now(),
      });
      // Tell other dashboards an agent came online — same event, just routed
      // through the existing SSE broadcast so views can update presence.
      fanout('agent:online', agents.get(socket.id));
    });

    socket.on('agent:event', async (payload) => {
      // Worker emits one of: workflow:changed | agent_step | inbox:invalidate |
      // capture_new | deploy_event. We re-emit on the dashboard SSE channel
      // with the same name so client code uses one subscription model.
      if (!payload || typeof payload !== 'object' || !payload.type) {
        return;
      }
      const { type, ...data } = payload;
      fanout(type, data);
    });

    socket.on('agent:goodbye', () => {
      const meta = agents.get(socket.id);
      agents.delete(socket.id);
      if (meta) fanout('agent:offline', { ...meta, reason: 'goodbye' });
    });

    // New event handlers for task claim/heartbeat/result protocol
    socket.on('agent:claim', async (payload, callback) => {
      try {
        const { token_id } = payload;
        if (!token_id) {
          return callback?.({ success: false, error: 'Missing token_id' });
        }

        // Verify the token exists and is valid
        const token = getTaskToken(token_id);
        if (!token) {
          return callback?.({ success: false, error: 'Invalid or expired token' });
        }

        // Check if token is already claimed
        if (token.claimed_at) {
          return callback?.({ success: false, error: 'Token already claimed' });
        }

        // Atomically claim the token
        const claimed = claimTaskToken(token_id);
        if (!claimed) {
          return callback?.({ success: false, error: 'Failed to claim token' });
        }

        // Register this claim in our task channels map
        taskChannels.set(token.task_id, {
          node_id: token.node_id,
          socket_id: socket.id,
          token_id: token_id
        });

        // Send success response
        callback?.({ success: true, task: { id: token.task_id, repository: token.repository, branch: token.branch } });
      } catch (error) {
        console.error('[agent-hub] claim error:', error);
        callback?.({ success: false, error: error.message });
      }
    });

    socket.on('agent:heartbeat', async (payload, callback) => {
      try {
        const { token_id } = payload;
        if (!token_id) {
          return callback?.({ success: false, error: 'Missing token_id' });
        }

        // Verify the token exists and is valid
        const token = getTaskToken(token_id);
        if (!token) {
          return callback?.({ success: false, error: 'Invalid or expired token' });
        }

        // Update heartbeat
        const updated = heartbeatTaskToken(token_id);
        if (!updated) {
          return callback?.({ success: false, error: 'Failed to update heartbeat' });
        }

        callback?.({ success: true });
      } catch (error) {
        console.error('[agent-hub] heartbeat error:', error);
        callback?.({ success: false, error: error.message });
      }
    });

    socket.on('agent:result', async (payload, callback) => {
      try {
        const { token_id, success, result } = payload;
        if (!token_id) {
          return callback?.({ success: false, error: 'Missing token_id' });
        }

        // Verify the token exists and is valid
        const token = getTaskToken(token_id);
        if (!token) {
          return callback?.({ success: false, error: 'Invalid or expired token' });
        }

        // Mark token as completed (idempotent)
        completeTaskToken(token_id);

        // Remove from task channels
        taskChannels.delete(token.task_id);

        callback?.({ success: true });
      } catch (error) {
        console.error('[agent-hub] result error:', error);
        callback?.({ success: false, error: error.message });
      }
    });

    socket.on('disconnect', (reason) => {
      const meta = agents.get(socket.id);
      agents.delete(socket.id);
      if (meta) fanout('agent:offline', { ...meta, reason });
    });
  });

  console.log('✓ Agent hub listening on /agents/socket.io');
  return io;
}

// Fanout an event from the hub → dashboard SSE clients. Lazy-import sse.js
// because some test setups stub it out.
async function fanout(name, data) {
  try {
    const { broadcast } = await import('./sse.js');
    broadcast(name, data);
  } catch { /* sse not wired in this process */ }
}

// Public: send an admin command back to a specific agent (or broadcast).
// Used by /api/commands/cancel-job, /api/commands/set-autonomy, etc.
export function sendAgentCommand({ agent_id = null, type, payload = {} }) {
  if (!io) throw new Error('agent hub not initialised');
  if (agent_id) {
    // Find the socket whose hello announced this agent_id.
    for (const [socketId, meta] of agents) {
      if (meta.agent_id === agent_id) {
        io.sockets.sockets.get(socketId)?.emit('admin:command', { type, payload });
        return true;
      }
    }
    return false;
  }
  io.emit('admin:command', { type, payload });
  return true;
}

export function listConnectedAgents() {
  return [...agents.values()];
}
