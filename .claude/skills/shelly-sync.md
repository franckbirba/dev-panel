---
name: shelly-sync
description: Sync work items between DevPanel, Plane, GitHub, and AFFiNE
---

# Shelly Hub Synchronization

Orchestrate data sync across all OpenClaw tools as per the flowchart hub architecture.

## Data Flow (from flowchart.md)

```
DevPanel (bugs/features) 
  → SHELLY (triage) 
  → Plane (work items) 
  → GitHub (issues/PRs) 
  → pgvector (memory)
```

## Sync Operations

### 1. DevPanel → Plane
```bash
# List pending DevPanel tickets
node bin/dev-panel.js list --status=pending

# Review and approve a ticket
node bin/dev-panel.js review <ticket-id>

# Publish to GitHub (creates issue)
node bin/dev-panel.js publish <ticket-id>

# Sync GitHub issue status back to DevPanel
node bin/dev-panel.js sync
```

### 2. Plane → GitHub
Using Plane MCP:
```javascript
// List Plane work items
mcp__plane__list_work_items({ project_id: "..." })

// Create GitHub issue from Plane work item
// (via SHELLY orchestration)
```

### 3. GitHub → Plane Status Sync
```bash
# Webhook: GitHub issue closed → update Plane
# Webhook: GitHub PR merged → update Plane module
# Manual: Pull latest GitHub issues
gh issue list --json number,title,state,labels
```

### 4. AFFiNE Knowledge Sync
```javascript
// Read specs from AFFiNE
mcp__affine__read_doc({ doc_id: "sprint-plan" })

// Write ADR to AFFiNE
mcp__affine__write_doc({ 
  title: "ADR-001: Architecture Decision",
  content: "..."
})
```

### 5. Penpot Design Sync
```javascript
// Read design frames (via Penpot MCP)
mcp__penpot__list_frames({ project_id: "..." })

// Extract design tokens
mcp__penpot__get_design_tokens({ frame_id: "..." })
```

## BullMQ Job Queue

Jobs enqueued by SHELLY:
- `shelly:triage` → Always runs (PM agent)
- `arch:review` → On-demand (Architect agent)
- `design:sprint` → On-demand (Designer agent)
- `build:task` → Concurrent (Builder agents ×N)
- `review:pr` → On push (Reviewer agent)
- `qa:run` → On merge (QA agent)
- `secu:check` → Blocking (Security agent)

## Validation Gates

From flowchart, human validation required for:
- ⚠️ Conception docs (Franck validates)
- ⚠️ Maquettes (Franck validates)
- ⚠️ ADR architecture (Franck validates)
- ⚠️ Security model (Franck validates)

## Manual Sync Commands

### Full Pipeline Sync
```bash
#!/bin/bash
set -e

echo "=== 1. DevPanel → GitHub ==="
node bin/dev-panel.js sync

echo "=== 2. GitHub → Plane ==="
# TODO: Implement via Plane API
# gh issue list --json number,state | jq '.[] | select(.state == "closed")'

echo "=== 3. Update pgvector Memory ==="
# TODO: Store semantic embeddings of completed work

echo "=== 4. Update AFFiNE Sprint Status ==="
# TODO: Write to AFFiNE via MCP

echo "✅ Sync complete"
```

### Bidirectional Status Sync
```bash
# GitHub → DevPanel
node bin/dev-panel.js sync

# Plane → GitHub (via webhook)
# Configured in Plane settings → Integrations → GitHub

# AFFiNE → Plane (manual)
# Read from AFFiNE docs, update Plane work items
```

## MinIO Asset Storage

Plane uses MinIO for file uploads:
```bash
# Check MinIO bucket
docker exec plane-minio mc ls planeminio/plane-uploads

# Upload file to MinIO
docker exec plane-minio mc cp /tmp/file.png planeminio/plane-uploads/

# Get presigned URL (via Plane API)
curl -X POST https://plane.devpanl.dev/api/v1/workspaces/{workspace}/files/
```

## MCP Server Connections

Active MCP servers (from flowchart):
- `affine` → Docs, specs, ADRs
- `penpot` → Design frames, tokens
- `plane` → Work items, cycles, modules
- `github` → Issues, PRs, reviews
- `devpanel` → Bug/feature reports (via REST API)

## Monitoring Sync Health

```bash
# Check BullMQ job counts
docker exec devpanel-redis redis-cli --scan --pattern "bull:*"

# Check DevPanel sync status
node bin/dev-panel.js stats

# Check Plane work items
# Via Plane MCP or API

# Check GitHub sync webhook logs
gh api /repos/OWNER/REPO/hooks
```
