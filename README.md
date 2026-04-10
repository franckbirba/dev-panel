# dev-panel

[![npm version](https://img.shields.io/npm/v/dev-panel.svg)](https://www.npmjs.com/package/dev-panel)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/franckbirba/dev-panel.svg)](https://github.com/franckbirba/dev-panel/stargazers)

A plug & play bug/feature reporting panel with SQLite storage and GitHub sync.

> Collect user feedback directly in your React app, review with AI assistance (Claude Code, Cursor, etc.), and publish to GitHub Issues - all with a simple workflow.

## Features

- 🐛 **Bug Reporting**: Users can report bugs with screenshots directly from your app
- 💡 **Feature Requests**: Collect feature requests from users
- 📦 **SQLite Storage**: Lightweight local database for ticket storage
- 🔄 **GitHub Sync**: Publish tickets as GitHub issues
- 🎯 **PM Review Workflow**: Review and format tickets before publishing (perfect with Claude Code)
- 🔌 **Plug & Play**: Easy installation in any React project
- 🚀 **Zero Config**: Auto-detects project settings from package.json

## Installation

```bash
npm install dev-panel
```

## Quick Start

### 1. Initialize in your project

```bash
npx dev-panel init
```

This creates:
- `.devpanelrc.json` - Configuration file
- `storage/` - SQLite database and uploads directory
- Updates `.gitignore` to exclude storage

### 2. Configure GitHub

Set your GitHub token:

```bash
# .env.local
GITHUB_TOKEN=ghp_xxxxxxxxxxxxx
```

Update `.devpanelrc.json` with your repo info:

```json
{
  "github": {
    "owner": "your-org",
    "repo": "your-repo"
  }
}
```

### 3. Add to React app

```jsx
// src/App.jsx
import { DevPanel } from 'dev-panel/react';

function App() {
  return (
    <>
      <YourApp />

      {/* Only show in development */}
      {import.meta.env.DEV && (
        <DevPanel
          apiUrl="http://localhost:3030"
          project="my-project"
        />
      )}
    </>
  );
}
```

### 4. Start the server

**Option A: Separate terminal**

```bash
# Terminal 1: Your dev server
npm run dev

# Terminal 2: DevPanel server
npx dev-panel serve
```

**Option B: Concurrent (recommended)**

```bash
# Install concurrently
npm install -D concurrently

# Update package.json
{
  "scripts": {
    "dev": "concurrently \"vite\" \"dev-panel serve\""
  }
}

# Run both with one command
npm run dev
```

## Workflow

### For Users (Reporting)

1. Click the 🐛 floating button in your app
2. Choose "Report Bug" or "Request Feature"
3. Fill in title and description
4. Optionally attach screenshot
5. Submit

Tickets are stored in local SQLite database with status `pending`.

### For PM (Review & Publish)

#### List pending tickets

```bash
npx dev-panel list --status=pending
```

Output:
```
┌────┬──────────┬─────────────────────────────────────┬───────────┬────────────┐
│ ID │ Type     │ Title                               │ Status    │ Created    │
├────┼──────────┼─────────────────────────────────────┼───────────┼────────────┤
│ 42 │ bug      │ Perdiem calculation broken          │ pending   │ 2h ago     │
│ 43 │ feature  │ Export CSV button                   │ pending   │ 1d ago     │
└────┴──────────┴─────────────────────────────────────┴───────────┴────────────┘
```

#### Review ticket (formatted for Claude Code)

```bash
npx dev-panel review 42
```

Output shows full ticket details optimized for Claude Code to help format.

#### Publish to GitHub

```bash
# Basic
npx dev-panel publish 42

# With options
npx dev-panel publish 42 \
  --title="[BUG] Attendance: Perdiem calculation error" \
  --labels="bug,attendance,priority:high" \
  --assignee="dev-team"
```

This:
1. Creates a formatted GitHub issue
2. Updates ticket status to `published`
3. Stores GitHub issue URL and number

#### Reject ticket

```bash
npx dev-panel reject 42 --reason="Duplicate of #45"
```

#### Sync with GitHub

```bash
# Sync all published tickets
npx dev-panel sync --auto
```

This checks GitHub for issue status and updates local tickets (e.g., marks as `closed` when GitHub issue is closed).

#### Stats

```bash
npx dev-panel stats
```

Output:
```
📊 DevPanel Statistics

Project: my-app
────────────────────────────────────────
Pending:      12
Published:    45
Closed:       38
Rejected:      5
────────────────────────────────────────
Total:       100
```

## CLI Reference

```bash
# Initialization
dev-panel init [--force]           # Initialize in current project

# Server
dev-panel serve                     # Start API server

# Ticket Management
dev-panel list [options]            # List tickets
  --status <status>                 #   Filter: pending|published|rejected|closed
  --project <project>               #   Filter by project
  --limit <number>                  #   Max results (default: 50)

dev-panel review <id>               # Review ticket details

dev-panel publish <id> [options]    # Publish ticket to GitHub
  --title <title>                   #   Override issue title
  --labels <labels>                 #   Comma-separated labels
  --assignee <user>                 #   GitHub username

dev-panel reject <id> [options]     # Reject ticket
  --reason <reason>                 #   Rejection reason

dev-panel sync [--auto]             # Sync with GitHub

dev-panel stats [--project <name>]  # Show statistics
```

## Configuration

`.devpanelrc.json`:

```json
{
  "project": "my-project",
  "storage": {
    "path": "./storage",
    "maxFileSize": "10MB"
  },
  "server": {
    "port": 3030,
    "host": "localhost"
  },
  "github": {
    "owner": "your-org",
    "repo": "your-repo",
    "token": "${GITHUB_TOKEN}",
    "labels": {
      "bug": ["bug", "needs-triage"],
      "feature": ["enhancement", "feature-request"]
    }
  },
  "sync": {
    "enabled": true,
    "interval": "15m"
  }
}
```

## Multi-Project Usage

You can use DevPanel in multiple projects on the same machine. Each project has its own:

- Configuration (`.devpanelrc.json`)
- Database (`storage/tickets.db`)
- Server port (configure different ports)

```bash
# Project 1
cd /path/to/project1
npx dev-panel serve  # Runs on port 3030

# Project 2
cd /path/to/project2
npx dev-panel serve  # Runs on port 3031 (if configured)
```

## Database Schema

SQLite table `tickets`:

```sql
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                    -- 'bug' | 'feature'
  status TEXT DEFAULT 'pending',         -- 'pending' | 'published' | 'rejected' | 'closed'

  title TEXT NOT NULL,
  description TEXT NOT NULL,
  context TEXT,                          -- JSON: {url, userAgent, timestamp, ...}
  screenshot_path TEXT,

  reviewed_at DATETIME,
  reviewed_by TEXT,
  rejection_reason TEXT,

  github_issue_number INTEGER,
  github_issue_url TEXT,
  github_synced_at DATETIME,
  github_status TEXT,                    -- 'open' | 'closed'

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT,
  project TEXT
);
```

## API Endpoints

The server exposes a REST API:

```
POST   /api/tickets              # Create ticket (from React UI)
GET    /api/tickets              # List tickets
GET    /api/tickets/:id          # Get ticket details
GET    /api/tickets/:id/screenshot  # Get screenshot file
PATCH  /api/tickets/:id          # Update ticket
DELETE /api/tickets/:id          # Delete/reject ticket
GET    /api/stats                # Get statistics
GET    /api/health               # Health check
```

## Troubleshooting

### Server won't start

- Check if port 3030 is already in use
- Verify `.devpanelrc.json` exists
- Check storage directory permissions

### GitHub integration not working

- Verify `GITHUB_TOKEN` is set correctly
- Check GitHub repo owner/name in config
- Ensure token has `repo` scope

### Screenshots not uploading

- Check `storage/uploads/` directory exists
- Verify file size is under 10MB
- Check file type is image (png, jpg, gif, webp)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT © [Franck Birba](https://github.com/franckbirba)

## Author

**Franck Birba**

- GitHub: [@franckbirba](https://github.com/franckbirba)
