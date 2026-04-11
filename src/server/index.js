import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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

  // Security headers
  app.use(helmet());

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

  return { app, config };
}

export function startServer(storagePath = './storage', port = 3030, host = 'localhost') {
  const { app } = createServer(storagePath);

  const server = app.listen(port, host, () => {
    console.log(`✓ DevPanel server running on http://${host}:${port}`);
    console.log(`✓ Storage: ${storagePath}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    if (process.env.ALLOWED_ORIGINS) {
      console.log(`✓ CORS: ${process.env.ALLOWED_ORIGINS}`);
    }
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  return server;
}
