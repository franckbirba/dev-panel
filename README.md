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

### Docker

```bash
docker build -t dev-panel .
docker run -p 3030:3030 -v ./storage:/app/storage dev-panel
```

### Docker Compose with Traefik + Let's Encrypt

The repo includes a production-ready setup:

```bash
# On your VPS
git clone https://github.com/franckbirba/dev-panel.git
cd dev-panel
cp .env.example .env    # Configure GITHUB_TOKEN, ADMIN_API_KEY, ALLOWED_ORIGINS
mkdir -p traefik && cp infra/traefik.yml infra/dynamic.yml traefik/
touch traefik/acme.json && chmod 600 traefik/acme.json
docker compose -f docker-compose.prod.yml up -d
```

### CI/CD

Push to `main` triggers GitHub Actions to build the Docker image, push to GHCR, and deploy to VPS via SSH.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub token for repo sync |
| `ADMIN_API_KEY` | Yes (prod) | Admin API key for project management |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins (default: `*`) |
| `NODE_ENV` | No | `production` or `development` |

### VPS Bootstrap

```bash
bash infra/setup-vps.sh
```

Sets up Docker, deploy user, UFW firewall (22/80/443), SSH hardening, and unattended upgrades.

## Package Exports

```javascript
import { createServer, startServer } from 'dev-panel';        // Server
import { DevPanel } from 'dev-panel/react';                    // React widget
import { createMCPServer } from 'dev-panel/mcp';               // MCP server
```

## License

MIT © [Franck Birba](https://github.com/franckbirba)
