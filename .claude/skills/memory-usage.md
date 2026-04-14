---
name: memory-usage
description: Guide for using the Memory MCP with VoyageAI embeddings for team knowledge
---

# Memory MCP — Team Knowledge & Context Storage

The Memory MCP provides persistent, searchable storage for team decisions, learnings, and context using VoyageAI embeddings.

## Overview

**MCP Server**: `@modelcontextprotocol/server-memory`
**Embeddings**: VoyageAI (voyage-3 model)
**Storage**: Local SQLite with vector search
**Use Cases**: Store decisions, ADRs, context, learnings, patterns

## Configuration

Already configured in `.claude/mcp.json`:

```json
{
  "memory": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"],
    "env": {
      "VOYAGE_API_KEY": "${VOYAGE_API_KEY}"
    }
  }
}
```

**Required**: Set `VOYAGE_API_KEY` in your environment (from VoyageAI dashboard).

## Available Tools

### 1. `store_memory`
Store new knowledge or decisions in team memory.

```javascript
mcp__memory__store_memory({
  content: "Decision: We chose Playwright over Cypress for E2E testing due to better multi-browser support and native async/await",
  tags: ["decision", "qa", "testing", "playwright"],
  metadata: {
    date: "2026-04-14",
    context: "QA automation infrastructure",
    author: "team",
    related_pr: "#123"
  }
})
```

**When to use:**
- After making architectural decisions
- When implementing new patterns
- After resolving complex bugs
- When discovering important context
- After team discussions/retrospectives

### 2. `search_memory`
Retrieve relevant memories using semantic search.

```javascript
mcp__memory__search_memory({
  query: "Why did we choose Playwright?",
  limit: 5,
  tags: ["testing", "qa"]
})
```

Returns memories ranked by semantic similarity to query.

**Use cases:**
- Before making similar decisions (check past decisions)
- When onboarding new team members
- When revisiting old features
- During code reviews (context for past decisions)

### 3. `list_memories`
List all stored memories (optionally filtered by tags).

```javascript
mcp__memory__list_memories({
  tags: ["decision"],
  limit: 10
})
```

### 4. `delete_memory`
Remove outdated or incorrect memories.

```javascript
mcp__memory__delete_memory({
  memory_id: "abc123"
})
```

## Usage Examples

### Example 1: Store Architectural Decision

```javascript
// After deciding on infrastructure approach
mcp__memory__store_memory({
  content: `
**Decision**: Consolidated 4 docker-compose files into 1 with profiles

**Reasoning**:
- Easier maintenance (single source of truth)
- Better developer experience (make deploy-all)
- Reduced duplication
- Supports partial deployments via profiles

**Profiles**: core, plane, penpot, monitoring

**Date**: 2026-04-13
**Files**: docker-compose.yml, Makefile
  `,
  tags: ["decision", "infrastructure", "docker", "devops"],
  metadata: {
    impact: "high",
    commit: "91ede58"
  }
})
```

### Example 2: Search for Past Decisions

```javascript
// Before implementing new MCP server
const memories = await mcp__memory__search_memory({
  query: "How do we add new MCP servers to the infrastructure?",
  limit: 3,
  tags: ["mcp", "infrastructure"]
})

// Returns:
// - Memory about adding Playwright MCP
// - Memory about Penpot MCP setup
// - Memory about MCP configuration pattern
```

### Example 3: Store Bug Resolution

```javascript
mcp__memory__store_memory({
  content: `
**Bug**: Ubuntu 24.04 renamed libasound2 to libasound2t64

**Resolution**: Updated install-playwright.sh to use libasound2t64

**Root Cause**: Ubuntu's t64 transition for time64 support

**Impact**: Playwright installation was failing on agents node

**Prevention**: Always check package availability with apt-cache search
  `,
  tags: ["bug", "ubuntu", "playwright", "dependency"],
  metadata: {
    severity: "medium",
    affected_node: "agents (62.238.0.167)",
    fix_commit: "0505938"
  }
})
```

### Example 4: Store Pattern/Best Practice

```javascript
mcp__memory__store_memory({
  content: `
**Pattern**: Idempotent secret generation in init.sh

**Implementation**:
\`\`\`bash
existing_or_new() {
  local key="$1"
  if [ -f "$ENV_FILE" ]; then
    grep "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || gen_secret
  else
    gen_secret
  fi
}
\`\`\`

**Benefits**:
- Re-running init.sh preserves existing secrets
- Safe to run multiple times
- No manual secret backup needed

**Use when**: Generating .env files that may be regenerated
  `,
  tags: ["pattern", "secrets", "devops", "bash"],
  metadata: {
    language: "bash",
    file: "infra/init.sh"
  }
})
```

## Integration with Agent Workflows

### PM Agent
Before triaging tickets:
```javascript
// Check if similar issues were resolved before
const pastSolutions = await mcp__memory__search_memory({
  query: ticket.description,
  tags: ["bug", "resolution"],
  limit: 3
})
```

### Designer Agent
Before creating designs:
```javascript
// Check design patterns and decisions
const designPatterns = await mcp__memory__search_memory({
  query: "design system tokens typography spacing",
  tags: ["design", "pattern"],
  limit: 5
})
```

### Builder Agent
Before implementing features:
```javascript
// Check architectural decisions
const archDecisions = await mcp__memory__search_memory({
  query: feature.description,
  tags: ["decision", "architecture"],
  limit: 5
})
```

### Reviewer Agent
During PR review:
```javascript
// Check if code follows established patterns
const patterns = await mcp__memory__search_memory({
  query: `${prTitle} ${filesPaths.join(' ')}`,
  tags: ["pattern", "best-practice"],
  limit: 3
})
```

## Memory Organization

### Recommended Tags

**By Type:**
- `decision` — Architectural/technical decisions
- `bug` — Bug reports and resolutions
- `pattern` — Reusable patterns and practices
- `learning` — Team learnings and insights
- `context` — Important project context
- `adr` — Architecture Decision Records

**By Domain:**
- `infrastructure`, `devops`, `docker`, `traefik`
- `frontend`, `react`, `ui`, `design`
- `backend`, `api`, `database`, `sqlite`
- `testing`, `qa`, `playwright`, `e2e`
- `mcp`, `agents`, `automation`
- `security`, `auth`, `secrets`

**By Impact:**
- `critical`, `high`, `medium`, `low`

### Metadata Fields

Standard metadata structure:
```javascript
{
  date: "YYYY-MM-DD",
  author: "team" | "agent-name" | "developer-name",
  context: "Brief context",
  impact: "critical" | "high" | "medium" | "low",
  related_pr: "#123",
  related_issue: "#456",
  commit: "abc123",
  files: ["path/to/file.js"],
  affects: ["component", "service"]
}
```

## Storage Location

- **Local**: `~/.mcp-memory/` (SQLite database)
- **Agents Node**: `/root/.mcp-memory/`
- **Services Node**: `/home/deploy/.mcp-memory/`

**Note**: Each node has its own memory database. For shared team memory, consider:
1. Periodic sync between nodes
2. Centralized memory service
3. Git-tracked memory exports

## VoyageAI API Usage

**Model**: `voyage-3` (default)
**Embedding Dimensions**: 1024
**Max Input**: 32,000 tokens
**Cost**: ~$0.12 per 1M tokens

**Monthly Estimate** (for team of 5 agents):
- 100 memories/day × 500 tokens avg = 50k tokens/day
- 1.5M tokens/month ≈ $0.18/month

**Rate Limits**: 300 requests/min (free tier)

## Best Practices

### ✅ Do:
- Store decisions immediately after making them
- Use descriptive tags (3-5 per memory)
- Include relevant metadata (commits, PRs, dates)
- Search memory before making new decisions
- Review and update memories during retrospectives
- Delete outdated memories

### ❌ Don't:
- Store sensitive credentials or secrets
- Store entire code files (store patterns/snippets instead)
- Use generic tags like "misc" or "other"
- Duplicate information (search first)
- Store temporary/experimental decisions

## Troubleshooting

### Issue: "VOYAGE_API_KEY not found"

**Fix**: Ensure env var is set:
```bash
# Local
export VOYAGE_API_KEY="pa-xxxxx"

# Production (in .env.production)
VOYAGE_API_KEY=pa-xxxxx
```

### Issue: "Rate limit exceeded"

**Fix**: VoyageAI free tier is 300 req/min. Batch operations or upgrade plan.

### Issue: "Memory not found in search"

**Possible causes**:
1. Tags don't match (use `list_memories` to see all tags)
2. Query is too specific (try broader search)
3. Memory was deleted

**Fix**: Try broader query or different tags.

## Example Workflow: Storing ADR

```javascript
// After team decision on new architecture

const adr = {
  content: `
# ADR-001: Unified Docker Compose with Profiles

## Status
Accepted

## Context
We had 4 separate docker-compose files:
- docker-compose.yml (core)
- docker-compose.plane.yml
- docker-compose.penpot.yml
- docker-compose.monitoring.yml

This caused:
- Deployment complexity
- Duplication (networks, volumes)
- Difficult to maintain

## Decision
Consolidate into single docker-compose.yml with profiles:
- \`core\`: Essential services (7)
- \`plane\`: Project management (10)
- \`penpot\`: Design tool (6)
- \`monitoring\`: Observability (2)

## Consequences
**Positive:**
- Single source of truth
- Easier deployment (make deploy-all)
- Better visibility (docker compose ps shows all)
- Reduced duplication

**Negative:**
- Larger file (468 lines)
- Must specify profiles explicitly

## Implementation
- File: docker-compose.yml
- Makefile targets: deploy-core, deploy-plane, etc.
- Profiles: --profile core, --profile all
  `,
  tags: ["adr", "decision", "infrastructure", "docker"],
  metadata: {
    date: "2026-04-13",
    number: "ADR-001",
    status: "accepted",
    impact: "high",
    commit: "91ede58",
    files: ["docker-compose.yml", "Makefile"]
  }
}

await mcp__memory__store_memory(adr)
```

Later, when making similar decisions:
```javascript
const related = await mcp__memory__search_memory({
  query: "How did we handle docker compose complexity?",
  tags: ["adr", "docker"],
  limit: 5
})
```

## Integration with Existing Tools

### With AFFiNE
Store high-level decisions in AFFiNE docs, technical details in Memory MCP.

### With Plane
Link memories to Plane work items via metadata:
```javascript
metadata: {
  plane_item: "DEV-123",
  sprint: "Sprint 15"
}
```

### With Obsidian
Export memories periodically to Obsidian vault for team wiki.

## Future Enhancements

- [ ] Automatic memory extraction from PR descriptions
- [ ] Memory sync between nodes
- [ ] Integration with git commit messages
- [ ] Slack/Telegram notifications for new memories
- [ ] Memory expiration/archival policy
- [ ] Team memory dashboard
