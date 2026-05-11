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
// Stateless mode (sessionIdGenerator: undefined): each request opens a fresh
// transport, no Mcp-Session-Id tracking. Fine for our workload (request/
// response tool calls), avoids the in-memory session map that would be lost
// on every plane-api recreate.

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { timingSafeEqual } from 'crypto';

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
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      res.on('close', () => {
        transport.close().catch(() => {});
      });
      await server.connect(transport);
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

  // GET — OpenCode's MCP SDK uses StreamableHTTP transport which expects
  // GET to return an SSE stream with an "endpoint" event containing the
  // POST URL. We can't route GET through the MCP transport (it needs
  // POST-first initialization), so we return the correct SSE handshake.
  app.get(path, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // MCP Streamable HTTP spec: GET must return an endpoint event
    const endpointUrl = `${req.protocol}://${req.get('host')}${path}`;
    res.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);
    res.end();
  });

  app.post(path, handler);

  console.log(`[mcp-http] mounted at ${path}`);
  return true;
}
