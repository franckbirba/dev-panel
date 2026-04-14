# OpenClaw Agent Skills

This directory contains skills for Claude Code agents in the OpenClaw workflow (see `/docs/flowchart.md`).

## Infrastructure Skills

- **`/stack-deploy`** — Deploy full stack (Traefik → DevPanel → Plane → AFFiNE → Penpot)
- **`/stack-status`** — Health checks, logs, resource usage
- **`/shelly-sync`** — Sync data across DevPanel → Plane → GitHub → AFFiNE

## Agent Skills

### PM Agent (`/agent-pm`)
**Trigger**: `shelly:triage` (always, on every new ticket)  
**Tools**: Plane MCP, DevPanel API, AFFiNE MCP, GitHub (read)

**Flow**:
1. List pending DevPanel tickets
2. Review ticket details
3. Create Plane work item
4. Route to Architect (if arch review needed)
5. Route to Designer (if design needed)
6. Assign to sprint/cycle
7. Update AFFiNE sprint board
8. Publish to GitHub (if approved)
9. Notify Franck (if validation needed)

---

### Designer Agent (`/agent-designer`)
**Trigger**: `design:sprint` (on-demand from PM)  
**Tools**: Penpot MCP, AFFiNE MCP, Plane MCP

**Flow**:
1. Read conception doc from AFFiNE
2. Create conception doc (if missing) → **VAL_CONCEPTION** ⚠️
3. Create wireframes in Penpot
4. Extract design tokens
5. Request validation → **VAL_MAQUETTE** ⚠️
6. Write design tokens to AFFiNE
7. Mark Plane work item as "ready-for-dev"
8. Enqueue `build:task`

---

### Builder Agent (`/agent-builder`)
**Trigger**: `build:task` (from PM or Designer)  
**Tools**: AFFiNE MCP (read), Penpot MCP (read), Plane MCP, GitHub (PR)

**Concurrency**: ×N parallel builders

**Flow**:
1. Read specs from AFFiNE
2. Read design tokens from Penpot
3. Update Plane: state = "in_progress"
4. Implement feature (code + tests)
5. Create GitHub PR
6. Update Plane: state = "in_review"
7. Enqueue `review:pr`

---

### Reviewer Agent (`/agent-reviewer`)
**Trigger**: `review:pr` (on push to PR)
**Tools**: GitHub MCP, AFFiNE MCP (read), Penpot MCP (read), Plane MCP

**Flow**:
1. Get PR details + files changed
2. Read specs from AFFiNE
3. Read design from Penpot
4. Check CI status
5. Review conformity (specs + design)
6. Leave review on GitHub (approve or request changes)
7. Update Plane work item
8. Enqueue `qa:run` (if approved)

---

### QA Agent (`/agent-qa`)
**Trigger**: `qa:run` (after PR merge or nightly cron)
**Tools**: Playwright MCP, DevPanel API, Plane MCP, GitHub (comments)

**Flow**:
1. Run smoke tests (API health, widget render, form submission)
2. Run E2E tests (complete bug report workflow, multi-project)
3. Visual regression testing (screenshot comparison)
4. Report results to Plane work item
5. Create DevPanel bug tickets for failures
6. Update GitHub PR with test status
7. Notify PM agent if critical tests fail

---

## Validation Gates (Human-in-the-loop)

From `/docs/flowchart.md`:

- **⚠️ VAL_CONCEPTION** — Franck validates conception docs (Designer agent)
- **⚠️ VAL_MAQUETTE** — Franck validates mockups (Designer agent)
- **⚠️ VAL_ARCHI** — Franck validates ADR (Architect agent, not yet implemented)
- **⚠️ VAL_SECU** — Franck validates security model (Security agent, not yet implemented)

All validation requests are sent via Telegram webhook (`SHELLY_TELEGRAM_WEBHOOK`).

---

## MCP Server Configuration

From `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "affine_workspace_9ba536be-bf23-4cbf-87e4-56c7afac6731": {
      "type": "streamable-http",
      "url": "https://affine.lan/api/workspaces/9ba536be-bf23-4cbf-87e4-56c7afac6731/mcp",
      "headers": {
        "Authorization": "Bearer ut_PLgvpr1_1peDXE6silzkTe1Wrxw9fAqfrxDtQ3bhvQQ"
      }
    },
    "plane": {
      "command": "uvx",
      "args": ["--python", "3.12", "plane-mcp-server"],
      "env": {
        "PLANE_BASE_URL": "https://plane.devpanl.dev",
        "PLANE_WORKSPACE_SLUG": "devpanl"
      }
    },
    "penpot": {
      "type": "streamable-http",
      "url": "https://penpot-mcp.devpanl.dev/mcp"
    },
    "dev-panel": {
      "command": "node",
      "args": ["/Users/franckbirba/DEV/dev-panel/src/mcp/server.js"]
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@automatalabs/mcp-server-playwright"]
    },
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@marekmarek/mcp-obsidian"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/Users/franckbirba/DEV/Obsidian Vault"
      }
    },
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "VOYAGE_API_KEY": "${VOYAGE_API_KEY}"
      }
    }
  }
}
```

---

## BullMQ Job Queue

Jobs (see `/docker-compose.yml` for Redis config):

- `shelly:triage` → PM Agent (always runs on new DevPanel ticket)
- `arch:review` → Architect Agent (on-demand, not yet implemented)
- `design:sprint` → Designer Agent (on-demand)
- `build:task` → Builder Agent (concurrent ×N)
- `review:pr` → Reviewer Agent (on push to PR)
- `qa:run` → **QA Agent** (after PR merge, nightly cron, on-demand) ✅
- `secu:check` → Security Agent (blocking, not yet implemented)

---

## Usage

```bash
# Deploy infrastructure
claude /stack-deploy

# Check stack health
claude /stack-status

# Sync data across tools
claude /shelly-sync

# Run agent workflows
claude /agent-pm       # Triage tickets, create work items
claude /agent-designer # Create wireframes, design tokens
claude /agent-builder  # Implement features, create PRs
claude /agent-reviewer # Review PRs for conformity
claude /agent-qa       # Run E2E tests with Playwright ✅
```

---

## Implementation Status

✅ **Implemented**:
- PM Agent (`/agent-pm`) — Triage & backlog management
- Designer Agent (`/agent-designer`) — Penpot integration
- Builder Agent (`/agent-builder`) — Code generation & PRs
- Reviewer Agent (`/agent-reviewer`) — PR reviews
- **QA Agent** (`/agent-qa`) — **Playwright E2E testing** ✅
- Infrastructure commands (`/stack-deploy`, `/stack-status`, `/shelly-sync`)

⏳ **Not Yet Implemented**:
- **Architect Agent** (`/agent-architect`) — ADR creation, impact analysis
- **Security Agent** (`/agent-secu`) — Permify integration, compliance checks
- **pgvector Memory** — Semantic search of past decisions
- **Telegram Bot** — Interactive validation via Telegram messages
