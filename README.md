# dev-panel

[![npm version](https://img.shields.io/npm/v/dev-panel.svg)](https://www.npmjs.com/package/dev-panel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/franckbirba/dev-panel.svg)](https://github.com/franckbirba/dev-panel/stargazers)

A plug & play bug/feature reporting system for React apps with multi-project support, GitHub sync, and MCP integration for AI-assisted ticket management.

> Users report bugs via a floating widget, PMs review tickets via CLI, and approved tickets are published as GitHub Issues.

## Features

- **Bug Reporting** — Users report bugs with screenshots directly from your React app
- **Feature Requests** — Collect feature ideas with full context capture
- **Multi-Project** — Centralized server with isolated databases per project
- **GitHub Sync** — Import repos, publish tickets as issues, bi-directional status sync
- **Doc Indexing** — Full-text search across project markdown docs (FTS5)
- **MCP Server** — AI assistants (Claude, Cursor, etc.) can manage tickets via Model Context Protocol
- **Production Ready** — Docker, Traefik, Let's Encrypt, CI/CD included

## Architecture

```
React DevPanel UI --> Express API --> SQLite storage --> CLI review --> GitHub Issues
                         |
                    MCP Server (AI assistants)
```

Four layers with clean separation:

- **React UI** (`src/react/DevPanel.jsx`) — Floating widget with screenshot capture
- **API Server** (`src/server/`) — Express REST API with API key auth and rate limiting
- **Database** (`src/server/db.js`) — Master `projects.db` + per-project `tickets.db` (SQLite via better-sqlite3)
- **CLI** (`bin/dev-panel.js` + `src/cli/commands/`) — Commander.js-based management tool

## Quick Start

### 1. Install

```bash
npm install dev-panel
```

### 2. Start the server

```bash
npx dev-panel serve
```

### 3. Create a project

```bash
# Import from GitHub (fetches open issues, milestones, docs)
npx dev-panel import https://github.com/your-org/your-repo -t ghp_xxxxx

# Or create manually
npx dev-panel admin create -n my-project -o your-org -r your-repo
```

This returns an **API key** (prefixed `dp_`) for the project.

### 4. Add the React widget

```jsx
import { DevPanel } from 'dev-panel/react';

function App() {
  return (
    <>
      <YourApp />
      <DevPanel
        apiUrl="http://localhost:3030"
        apiKey="dp_your_project_key_here"
      />
    </>
  );
}
```

**Props:**
| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `apiUrl` | string | `http://localhost:3030` | API server URL |
| `apiKey` | string | *required* | Project API key |

The widget captures URL, user agent, viewport dimensions, and timestamp automatically. Bug reports support optional screenshot attachments.

## CLI Reference

### Server

```bash
dev-panel serve [-p 3030] [-H localhost] [-s ./storage]
```

### Project Management

```bash
dev-panel admin create -n <name> -o <owner> -r <repo> [-t <token>]
dev-panel admin list
dev-panel admin show <name>
dev-panel admin delete <name> --yes

dev-panel import <github-url> [-t <token>]    # Import repo + issues + milestones + docs
```

### Ticket Workflow

```bash
dev-panel list [-s pending|published|rejected|closed] [-p <project>] [-l 50]
dev-panel review <id>                          # Formatted output for AI assistants
dev-panel publish <id> [-t <title>] [-l <labels>] [-a <assignee>]
dev-panel reject <id> [-r <reason>]
dev-panel sync [--auto]                        # Sync status with GitHub issues
dev-panel stats [-p <project>]
```

### Documentation

```bash
dev-panel sync-docs [project]                  # Sync markdown docs from GitHub (incremental)
```

### Clarifications

```bash
dev-panel clarify list [-p <project>]
dev-panel clarify answer <project> <ticket-id> <answer>
```

## API Endpoints

All project-scoped endpoints require `X-API-Key` header. Admin endpoints require `X-Admin-Key` header.

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all projects |
| POST | `/api/projects/import` | Import GitHub repo as project |

### Tickets

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tickets` | Create ticket (rate-limited: 30/min) |
| GET | `/api/tickets` | List tickets (`?status`, `?limit`) |
| GET | `/api/tickets/:id` | Get ticket details |
| PATCH | `/api/tickets/:id` | Update ticket |
| DELETE | `/api/tickets/:id` | Delete/reject ticket |
| GET | `/api/tickets/:id/screenshot` | Get screenshot image |

### Documentation

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/docs` | List docs |
| GET | `/api/docs/search` | Full-text search (`?q`, `?limit`) |
| POST | `/api/docs/sync` | Sync docs from GitHub |

### Other

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/milestones` | List milestones (`?state`) |
| GET | `/api/clarifications` | List pending clarification questions |
| POST | `/api/tickets/:id/answer` | Answer a clarification |
| GET | `/api/stats` | Ticket statistics |

## MCP Server

dev-panel exposes an MCP server for AI assistants (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "dev-panel": {
      "command": "node",
      "args": ["node_modules/dev-panel/src/mcp/server.js"]
    }
  }
}
```

**Available tools:**

| Tool | Description |
|------|-------------|
| `list_projects` | Get all projects with GitHub info |
| `get_bugs` | List tickets (supports status/limit filters) |
| `get_context` | Full-text search project documentation |
| `update_status` | Change ticket status |
| `ask_clarification` | Post clarification question on ticket |
| `get_project_info` | Get project stats |

## Production Deployment

Complete production infrastructure with Traefik, Let's Encrypt, AFFiNE, Plane, Penpot, and monitoring. See **[infra/README.md](infra/README.md)** for full docs.

### Quick Deploy

```bash
# Local: build image
make build
make push

# Production: deploy everything
make deploy-all
```

### Or deploy via GitHub Actions

Push to `main` → auto-builds → pushes to GHCR → deploys to VPS.

### Manual Setup

```bash
# 1. Initialize .env
make init

# 2. Fill in secrets
vim .env  # GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, etc.

# 3. Deploy
make deploy-core       # Core only (traefik, devpanel, affine)
make deploy-plane      # Add Plane project management
make deploy-penpot     # Add Penpot design tool
make deploy-monitoring # Add monitoring stack
```

### Services

| Service | URL | Description |
|---------|-----|-------------|
| DevPanel | https://devpanl.dev | Main app |
| AFFiNE | https://affine.devpanl.dev | Docs & knowledge base |
| Plane | https://plane.devpanl.dev | Project management |
| Penpot | https://penpot.devpanl.dev | Design tool |
| Traefik | https://traefik.devpanl.dev | Reverse proxy dashboard |
| Uptime Kuma | https://status.devpanl.dev | Service monitoring |
| Bull Board | https://queues.devpanl.dev | Job queue dashboard |

## Package Exports

```javascript
import { createServer, startServer } from 'dev-panel';        // Server
import { DevPanel } from 'dev-panel/react';                    // React widget
import { createMCPServer } from 'dev-panel/mcp';               // MCP server
```

## License

MIT © [Franck Birba](https://github.com/franckbirba)
