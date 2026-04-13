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

## Validation Gates (Human-in-the-loop)

From `/docs/flowchart.md`:

- **⚠️ VAL_CONCEPTION** — Franck validates conception docs (Designer agent)
- **⚠️ VAL_MAQUETTE** — Franck validates mockups (Designer agent)
- **⚠️ VAL_ARCHI** — Franck validates ADR (Architect agent, not yet implemented)
- **⚠️ VAL_SECU** — Franck validates security model (Security agent, not yet implemented)

All validation requests are sent via Telegram webhook (`SHELLY_TELEGRAM_WEBHOOK`).

---

## MCP Server Configuration

From `.mcp.json`:

```json
{
  "mcpServers": {
    "plane": {
      "command": "uvx",
      "args": ["--python", "3.12", "plane-mcp-server", "stdio"],
      "env": {
        "PLANE_API_KEY": "plane_api_...",
        "PLANE_WORKSPACE_SLUG": "devpanl",
        "PLANE_BASE_URL": "https://plane.devpanl.dev"
      }
    },
    "penpot": {
      "url": "https://penpot-mcp.devpanl.dev/mcp"
    },
    "affine": {
      "command": "affine-mcp",
      "env": {
        "AFFINE_BASE_URL": "http://localhost:3010",
        "AFFINE_API_TOKEN": "ut_...",
        "AFFINE_WORKSPACE_ID": "9ba536be-bf23-..."
      }
    }
  }
}
```

---

## BullMQ Job Queue

Jobs (see `/infra/docker-compose.yml` for Redis config):

- `shelly:triage` → PM Agent (always runs)
- `arch:review` → Architect Agent (on-demand, not yet implemented)
- `design:sprint` → Designer Agent (on-demand)
- `build:task` → Builder Agent (concurrent ×N)
- `review:pr` → Reviewer Agent (on push)
- `qa:run` → QA Agent (on merge, not yet implemented)
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
claude /agent-pm
claude /agent-designer
claude /agent-builder
claude /agent-reviewer
```

---

## Next Steps (Not Yet Implemented)

- **Architect Agent** (`/agent-architect`) — ADR creation, impact analysis
- **QA Agent** (`/agent-qa`) — E2E tests, smoke tests
- **Security Agent** (`/agent-secu`) — Permify integration, compliance checks
- **pgvector Memory** — Semantic search of past decisions
- **Telegram Bot** — Interactive validation via Telegram
