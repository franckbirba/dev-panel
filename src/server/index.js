import express from 'express';
import cors from 'cors';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { initDatabase } from './db.js';
import { initGitHub } from './github.js';
import { createRouter } from './routes.js';

export function createServer(configPath = './.devpanelrc.json') {
  // Load config
  let config = {
    project: 'unknown',
    storage: { path: './storage' },
    server: { port: 3030, host: 'localhost' },
    github: {}
  };

  if (existsSync(configPath)) {
    const configFile = readFileSync(configPath, 'utf-8');
    config = { ...config, ...JSON.parse(configFile) };
  }

  // Initialize database
  initDatabase(config.storage.path);

  // Initialize GitHub if token provided
  if (config.github.token && config.github.token !== '${GITHUB_TOKEN}') {
    initGitHub(config.github.token);
  } else if (process.env.GITHUB_TOKEN) {
    initGitHub(process.env.GITHUB_TOKEN);
  }

  // Create Express app
  const app = express();

  // Middleware
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Routes
  app.use('/api', createRouter(config));

  // Static files (for screenshots in development)
  app.use('/storage', express.static(config.storage.path));

  return { app, config };
}

export function startServer(configPath) {
  const { app, config } = createServer(configPath);

  const port = config.server.port || 3030;
  const host = config.server.host || 'localhost';

  const server = app.listen(port, host, () => {
    console.log(`✓ DevPanel server running on http://${host}:${port}`);
    console.log(`✓ Project: ${config.project}`);
    console.log(`✓ Storage: ${config.storage.path}`);
    if (config.github.owner && config.github.repo) {
      console.log(`✓ GitHub: ${config.github.owner}/${config.github.repo}`);
    }
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
