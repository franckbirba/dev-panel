import express from 'express';
import cors from 'cors';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { initMasterDatabase } from './db.js';
import { initGitHub } from './github.js';
import { createRouter } from './routes.js';

export function createServer(storagePath = './storage') {
  // Initialize master database (projects.db)
  initMasterDatabase(storagePath);

  // Default config
  const config = {
    storagePath,
    server: { port: 3030, host: 'localhost' }
  };

  // Create Express app
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' })); // Increase limit for base64 images
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Routes
  app.use('/api', createRouter(config));

  return { app, config };
}

export function startServer(storagePath = './storage', port = 3030, host = 'localhost') {
  const { app, config } = createServer(storagePath);

  const server = app.listen(port, host, () => {
    console.log(`✓ DevPanel server running on http://${host}:${port}`);
    console.log(`✓ Storage: ${storagePath}`);
    console.log(`✓ Multi-project mode with API key authentication`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });

  return server;
}
