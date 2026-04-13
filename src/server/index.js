import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { fileURLToPath } from 'url';
import path from 'path';
import { initMasterDatabase } from './db.js';
import { createRouter } from './routes.js';

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

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Routes
  app.use('/api', createRouter(config));

  // Root redirect to dashboard
  app.get('/', (req, res) => res.redirect('/dashboard'));

  // Dashboard SPA
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dashboardDistDir = path.join(__dirname, '..', '..', 'dist', 'dashboard');

  // Serve built dashboard assets with fallthrough
  app.use('/dashboard', express.static(dashboardDistDir, { fallthrough: true }));

  // SPA fallback — serve index.html for all /dashboard/* routes (only if static didn't match)
  app.get('/dashboard/*', (req, res) => {
    res.sendFile(path.join(dashboardDistDir, 'index.html'));
  });

  return { app, config };
}

export function startServer(storagePath = './storage', port = 3030, host = 'localhost') {
  let queueUpdateInterval = null;
  const { app } = createServer(storagePath);

  const server = app.listen(port, host, async () => {
    console.log(`✓ DevPanel server running on http://${host}:${port}`);
    console.log(`✓ Storage: ${storagePath}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✓ CORS: ${process.env.ALLOWED_ORIGINS || '* (all origins)'}`);

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
