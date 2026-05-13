// HTTP transport for the devpanel MCP server.
//
// The MCP server in src/mcp/server.js was originally stdio-only. This module
// mounts an McpServer instance on Express via StreamableHTTPServerTransport
// so remote Claude Code / Claude Desktop / opencode instances can reach it
// over HTTPS at devpanl.dev/mcp instead of needing a local clone of this repo.
//
// Auth: Authorization: Bearer <ADMIN_API_KEY>. The traefik router for this
// path is wired WITHOUT oauth-google@docker (a Bearer client can't satisfy
// Google SSO), so auth lives entirely here. If ADMIN_API_KEY is unset we
// refuse to mount — running unauthenticated would expose dispatch/memory
// tools to anyone who can reach devpanl.dev.
//
// Stateful sessions: an MCP handshake is initialize → notifications/initialized
// → tool calls. The SDK requires the same transport instance across all three
// hops, otherwise the second hop returns "Server not initialized" (the SDK
// only flips its internal initialized flag on the transport that handled the
// init). We keep transports in an in-memory Map keyed by mcp-session-id, the
// pattern shown in the SDK's streamableHttp examples. State is lost on
// container recreate — clients reconnect via a fresh initialize, no big deal.
//
// Per-session McpServer: an `McpServer` can only be `connect()`ed to ONE
// transport at a time — the SDK throws "Already connected" if reused. So we
// call `buildServer()` (from src/mcp/server.js) for each new session and
// connect that fresh instance to the new transport. This lets multiple
// HTTP clients (e.g. opencode opening parallel sessions for parallel tool
// calls) coexist without the activeTransport-serialization wart that the
// previous implementation needed when there was only one shared singleton.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, timingSafeEqual } from 'crypto';
import { buildServer } from '../mcp/server.js';

function safeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function mountMcpHttp(app, { server: _legacyServer, token, path = '/mcp' } = {}) {
  // _legacyServer is kept in the signature for back-compat with callers but
  // unused — we now spin up one McpServer per session via buildServer().
  if (!token) {
    console.warn(`[mcp-http] ADMIN_API_KEY not set — ${path} disabled`);
    return false;
  }

  // sessionId -> { transport, server } so we can close both on session end.
  const sessions = new Map();

  const handler = async (req, res) => {
    const authz = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(authz);
    if (!m || !safeEqual(m[1].trim(), token)) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
      return;
    }

    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport;

      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId).transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // Fresh session: new McpServer, new transport, no shared state with
        // any other session. The SDK's transports.set callback fires after
        // the session-id is assigned in the init response.
        const sessionServer = buildServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server: sessionServer });
          },
        });
        transport.onclose = async () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          try { await sessionServer.close?.(); } catch { /* ignore */ }
        };
        await sessionServer.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp-http] handler error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        });
      }
    }
  };

  // SSE-style GET and DELETE are part of the streamable-http spec for
  // server-initiated notifications and session termination. We support both
  // via the same auth check + session lookup; the transport itself handles
  // the protocol semantics.
  const sessionDispatch = async (req, res) => {
    const authz = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(authz);
    if (!m || !safeEqual(m[1].trim(), token)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await entry.transport.handleRequest(req, res);
  };

  app.get(path, sessionDispatch);
  app.delete(path, sessionDispatch);
  app.post(path, handler);

  console.log(`[mcp-http] mounted at ${path}`);
  return true;
}
