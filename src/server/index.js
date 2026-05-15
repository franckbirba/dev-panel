import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import path from 'path';
import { initMasterDatabase, getMasterDatabase } from './db.js';
import { createRouter } from './routes.js';
import { mountDevBotsRoutes } from './routes-dev-bots.js';
import { mountGitHubWebhook } from './webhooks-github.js';
import { mountGlitchTipWebhook } from './webhooks-glitchtip.js';
import { mountChat } from './chat.js';
import { mountDashboardChat } from './routes-dashboard-chat.js';

export function createServer(storagePath = './storage') {
  // Initialize master database (projects.db)
  initMasterDatabase(storagePath);

  const config = {
    storagePath,
    server: { port: 3030, host: 'localhost' }
  };

  const app = express();

  // Trust proxy (required for Traefik reverse proxy)
  app.set('trust proxy', 1);

  // Security headers — disable CSP (Cloudflare handles it)
  app.use(helmet({
    contentSecurityPolicy: false,
  }));

  // CORS — restrict origins in production
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['*'];

  if (allowedOrigins.includes('*')) {
    app.use(cors());
  } else {
    app.use(cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (server-to-server, curl, etc.)
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      }
    }));
  }

  // GitHub webhook must be mounted BEFORE express.json() so that the raw
  // body is available for HMAC signature verification. The route uses its
  // own express.raw() parser internally.
  mountGitHubWebhook(app);
  // Same constraint for GlitchTip — HMAC needs the unparsed bytes.
  mountGlitchTipWebhook(app);

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Strip the Next `basePath: "/dashboard"` prefix from API calls. The chat
  // app is served at /dashboard/ and its components issue relative fetches
  // like `api/dashboard/chat/turn` which the browser resolves to
  // `/dashboard/api/dashboard/chat/turn`. In `next dev` the basePath: false
  // rewrite in next.config.ts strips the leading /dashboard; in the
  // production static export served by Express there is no such layer, so
  // we strip it here. Works for every relative `api/...` fetch in the app.
  app.use((req, _res, next) => {
    if (req.url.startsWith('/dashboard/api/')) {
      req.url = req.url.slice('/dashboard'.length);
    }
    next();
  });

  // Remote MCP transport — exposes the same tools as the stdio MCP server
  // at /mcp via StreamableHTTPServerTransport. Bearer auth, no SSO. The
  // server module self-bootstraps on import (stdio); MCP_NO_AUTOSTART=1
  // suppresses that so we own the transport here.
  if (process.env.ENABLE_MCP_HTTP === 'true') {
    process.env.MCP_NO_AUTOSTART = '1';
    Promise.all([
      import('../mcp/server.js'),
      import('./mcp-http.js'),
    ]).then(([{ server }, { mountMcpHttp }]) => {
      return mountMcpHttp(app, { server, token: process.env.ADMIN_API_KEY });
    }).catch(err => {
      console.error('[mcp-http] failed to mount:', err);
    });
  }

  // Routes
  app.use('/api', createRouter(config));
  mountDevBotsRoutes(app);
  // /api/chat — streaming LLM proxy + MCP tool surface for apps/chat
  mountChat(app);
  // /api/dashboard/chat/* — SSO-gated thread persistence for the browser chat
  mountDashboardChat(app);

  // Dashboard SPA
  // - dist/dashboard/        → new chat-first surface (apps/chat, Next static export)
  // - dist/dashboard-legacy/ → old Vite SPA, served when `?legacy=1` is on the URL
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dashboardDistDir = path.join(__dirname, '..', '..', 'dist', 'dashboard');
  const dashboardLegacyDir = path.join(__dirname, '..', '..', 'dist', 'dashboard-legacy');

  // Standalone DevPanel widget bundle — served at /widget.js so any staff
  // site can embed with a single <script> tag. 5-minute cache so bumps
  // propagate quickly without explicit versioning. Spec:
  // docs/superpowers/specs/2026-04-22-standalone-widget-design.md
  const widgetPath = path.join(__dirname, '..', '..', 'dist', 'widget.js');
  app.get('/widget.js', (req, res) => {
    res.type('application/javascript');
    // Helmet defaults CORP to same-origin which blocks cross-origin <script>
    // loads — the whole point of /widget.js is to be embedded by other
    // staff sites (edms.epitools.bj etc.), so override to cross-origin.
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    // sendFile's maxAge is authoritative — setting Cache-Control via res.set()
    // before sendFile() gets overridden by Express's 0-default maxAge logic.
    // Pass it as an option and Express emits the right header.
    res.sendFile(widgetPath, { maxAge: 300_000 }, (err) => {
      if (err && !res.headersSent) res.status(404).send('widget not built');
    });
  });

  // Cache headers for dashboard assets — same strategy on both surfaces:
  //   - Hashed bundles (Vite `assets/index-<hash>.{js,css}` and Next
  //     `_next/static/<hash>/...`) are content-addressed, immutable forever.
  //   - Everything else (notably index.html) MUST NOT be cached, otherwise
  //     Cloudflare keeps serving an index.html that references a bundle hash
  //     we've already replaced ("I deployed but I still see the old version").
  //     Fixed 2026-05-10.
  function dashboardSetHeaders(res, filePath) {
    if (
      /\/assets\/index-[A-Za-z0-9_-]+\.(js|css)$/.test(filePath) ||
      /\/_next\/static\//.test(filePath)
    ) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }

  // Static asset serving — try the new chat dir first, then the legacy dir.
  // `?legacy=1` only controls which `index.html` the SPA fallback returns;
  // hashed assets are content-addressed and live in distinct paths
  // (`_next/static/...` vs `assets/...`) so cross-fallback is safe.
  // `index: false` prevents express.static from auto-serving index.html on
  // bare directory hits — that needs to flow through `sendDashboardIndex`
  // which honors `?legacy=1`.
  app.use('/dashboard', express.static(dashboardDistDir, {
    fallthrough: true,
    index: false,
    setHeaders: dashboardSetHeaders,
  }));
  app.use('/dashboard', express.static(dashboardLegacyDir, {
    fallthrough: true,
    index: false,
    setHeaders: dashboardSetHeaders,
  }));

  // SPA fallback — serve index.html for all /dashboard/* routes and root.
  // Force no-cache so CF and browsers re-fetch on every navigation; the file
  // is small and the asset bundles it references are immutable + forever-
  // cacheable, so this is cheap.
  function sendDashboardIndex(req, res) {
    const dir = req.query.legacy === '1' ? dashboardLegacyDir : dashboardDistDir;
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(dir, 'index.html'));
  }
  app.get('/dashboard', sendDashboardIndex);
  app.get('/dashboard/*', sendDashboardIndex);
  app.get('/', sendDashboardIndex);

  return { app, config };
}

export function startServer(storagePath = './storage', port = 3030, host = 'localhost') {
  let queueUpdateInterval = null;
  const { app } = createServer(storagePath);

  // Backward-compat: seed Franck's row from legacy TELEGRAM_BOT_TOKEN env if empty.
  import('./dev-bots.js').then(({ seedFromEnvIfEmpty }) => seedFromEnvIfEmpty())
    .then(r => { if (r?.seeded) console.log(`[dev-bots] seeded franck row id=${r.id}`); })
    .catch(err => console.error('[dev-bots] seed failed (non-fatal):', err.message));

  const server = app.listen(port, host, async () => {
    console.log(`✓ DevPanel server running on http://${host}:${port}`);
    console.log(`✓ Storage: ${storagePath}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✓ CORS: ${process.env.ALLOWED_ORIGINS || '* (all origins)'}`);

    // Agent socket.io hub — workers on the agents host connect here and
    // stream events live. Replaces postgres-as-bus polling. Refuses to
    // start without AGENT_HUB_TOKEN to avoid running unauthenticated.
    if (process.env.AGENT_HUB_TOKEN) {
      try {
        const { initAgentHub } = await import('./agent-hub.js');
        initAgentHub(server, { token: process.env.AGENT_HUB_TOKEN });
      } catch (err) {
        console.error('[agent-hub] failed to start:', err.message);
      }
    } else {
      console.warn('[agent-hub] AGENT_HUB_TOKEN not set — agent socket.io disabled');
    }

    // Start monitoring
    if (process.env.ENABLE_MONITORING === 'true') {
      const { alertManager } = await import('./alerts.js');
      alertManager.start(60000); // Flush every minute

      console.log('✓ Alert manager started');

      // Monitor queues if BullMQ is enabled
      if (process.env.ENABLE_BULLMQ === 'true') {
        const { monitorQueue, QUEUES } = await import('./bullmq.js');

        Object.values(QUEUES).forEach(queue => {
          monitorQueue(queue, (alert) => {
            alertManager.add(alert);
          });
        });

        console.log('✓ Queue monitoring started');

        // SSE broadcast of queue health every 5s
        const { broadcast } = await import('./sse.js');
        let lastQueueSnapshot = null;

        queueUpdateInterval = setInterval(async () => {
          try {
            const { getAllQueuesHealth } = await import('./bullmq.js');
            const health = await getAllQueuesHealth();
            const snapshot = JSON.stringify(health);

            // Only broadcast on change
            if (snapshot !== lastQueueSnapshot) {
              lastQueueSnapshot = snapshot;
              broadcast('queue:update', health);
            }
          } catch {
            // Redis may be down — broadcast unreachable status
            const unreachable = { status: 'unreachable', timestamp: new Date().toISOString() };
            const snapshot = JSON.stringify(unreachable);
            if (snapshot !== lastQueueSnapshot) {
              lastQueueSnapshot = snapshot;
              broadcast('queue:update', unreachable);
            }
          }
        }, 5000);

        console.log('✓ Queue SSE broadcasting started (5s interval)');
      }
    }
  });

  process.on('SIGTERM', async () => {
    console.log('SIGTERM received, shutting down gracefully...');

    // Stop alert manager
    if (process.env.ENABLE_MONITORING === 'true') {
      const { alertManager } = await import('./alerts.js');
      alertManager.stop();
    }

    if (queueUpdateInterval) clearInterval(queueUpdateInterval);

    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  return server;
}
