// HTTP transport for the devpanel MCP server.
//
// The MCP server in src/mcp/server.js was originally stdio-only. This module
// mounts the same `server` object on Express via StreamableHTTPServerTransport
// so remote Claude Code / Claude Desktop instances can reach it over HTTPS at
// devpanl.dev/mcp instead of needing a local clone of this repo.
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
// One-server-per-session constraint: an `McpServer` can only be `connect()`ed
// to ONE transport at a time — the SDK throws "Already connected to a
// transport". We're given a singleton `server` (the stdio one), so we
// SERIALIZE init across HTTP sessions: before connecting the singleton to a
// new transport, we close any prior transport. Sessions are short-lived in
// Claude Code's pattern (init → tools/list → call → close) so the practical
// impact is minimal; if we ever need true parallelism we'd refactor
// src/mcp/server.js into a `buildServer()` factory and use that here.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, timingSafeEqual } from 'crypto';

function safeEqual(a, b) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export async function mountMcpHttp(app, { server, token, path = '/mcp' } = {}) {
  if (!server) throw new Error('mountMcpHttp: server is required');
  if (!token) {
    console.warn(`[mcp-http] ADMIN_API_KEY not set — ${path} disabled`);
    return false;
  }

  const transports = new Map();
  let activeTransport = null;
  let initLock = Promise.resolve();

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

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // Serialize init: an McpServer can only be connected to one transport
        // at a time. Wait for any in-flight init to settle, then take over.
        const myInit = (async () => {
          await initLock.catch(() => {});
          // Disconnect prior transport from the singleton McpServer before
          // reusing it. close() flips Protocol._transport back to undefined.
          if (activeTransport) {
            try { await activeTransport.close(); } catch { /* already closed */ }
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
            if (activeTransport === transport) activeTransport = null;
          };
          activeTransport = transport;
          await server.connect(transport);
        })();
        initLock = myInit;
        await myInit;
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
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get(path, sessionDispatch);
  app.delete(path, sessionDispatch);
  app.post(path, handler);

  console.log(`[mcp-http] mounted at ${path}`);
  return true;
}
