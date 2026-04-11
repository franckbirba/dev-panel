# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

dev-panel is a plug & play bug/feature reporting system for React apps. Users report issues via a floating UI widget, PMs review tickets via CLI, and approved tickets are published as GitHub issues.

**Flow:** React DevPanel UI → Express API → SQLite storage → CLI review → GitHub Issues

## Commands

```bash
# No build step needed (pure ESM)
npm run build    # no-op

# No tests yet
npm run test     # no-op

# Run the CLI
node bin/dev-panel.js <command>

# Start the API server (default port 3030)
node bin/dev-panel.js serve

# Key CLI commands
node bin/dev-panel.js init              # Initialize project config
node bin/dev-panel.js list              # List tickets
node bin/dev-panel.js review <id>       # Show ticket details
node bin/dev-panel.js publish <id>      # Push ticket to GitHub
node bin/dev-panel.js reject <id>       # Reject a ticket
node bin/dev-panel.js sync              # Sync with GitHub
node bin/dev-panel.js stats             # Dashboard
node bin/dev-panel.js admin             # Project management (hidden command)
```

## Architecture

The package has four layers with clean separation:

- **CLI** (`bin/dev-panel.js` + `src/cli/commands/`) — Commander.js-based command router with 8 commands
- **API Server** (`src/server/index.js`, `src/server/routes.js`) — Express REST API with API key auth (`X-API-Key` header). Exports `createServer` and `startServer`
- **Database** (`src/server/db.js`) — Two-level SQLite via better-sqlite3: master `projects.db` (multi-project registry with API keys) and per-project `projectId/tickets.db` (tickets with BLOB screenshot storage)
- **React UI** (`src/react/DevPanel.jsx`) — Floating bug/feature report widget with screenshot capture. Exported via `./react` package entry point

## Key Design Decisions

- **Pure ESM** — All files use ES module imports, no CommonJS
- **Multi-project architecture** — Each project gets its own SQLite database, identified by API key
- **No external DB** — Everything is local SQLite files under a `storage/` directory
- **Screenshots stored as BLOBs** — Base64 images stored directly in SQLite, served via `/api/tickets/:id/screenshot`
- **GitHub sync is bidirectional** — Publishes tickets as issues and syncs status back when issues close

## Package Exports

- Default (`.`) → `src/server/index.js` (server functions)
- `./react` → `src/react/index.js` (DevPanel component)
- Binary: `dev-panel` CLI command

## Configuration

Project config lives in `.devpanelrc.json` (template at `templates/.devpanelrc.json`). Contains project name, server port, GitHub credentials, sync settings, and storage path.
