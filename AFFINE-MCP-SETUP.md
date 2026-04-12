# AFFiNE MCP Server Setup

Setup guide for integrating AFFiNE self-hosted with Claude Code via MCP.

## Installation

```bash
# Install globally
npm install -g affine-mcp-server

# Verify
affine-mcp --version
# Output: affine-mcp 1.13.0
```

## Configuration

### 1. Configure AFFiNE connection

Edit `~/.config/affine-mcp/config`:

```json
{
  "baseUrl": "https://affine.lan",
  "auth": {
    "type": "email",
    "email": "your-email@example.com",
    "password": "your-password"
  }
}
```

**For production (devpanl.dev):**
```json
{
  "baseUrl": "https://devpanl.dev/affine",
  "auth": {
    "type": "email",
    "email": "admin@devpanl.dev",
    "password": "your-secure-password"
  }
}
```

**Alternative: API Token (recommended for prod)**
```json
{
  "baseUrl": "https://devpanl.dev/affine",
  "auth": {
    "type": "token",
    "token": "your-affine-api-token"
  }
}
```

### 2. Test connection

```bash
affine-mcp status
# Should show user info if connected

affine-mcp doctor
# Run diagnostics
```

### 3. Add to Claude Code MCP config

Run interactive command:

```bash
claude mcp add
```

Or manually add to your Claude Code config:

```json
{
  "mcpServers": {
    "affine": {
      "command": "affine-mcp"
    }
  }
}
```

### 4. Verify MCP tools

Restart Claude Code and check available tools:

```
List MCP servers
→ Should show "affine" with ~35 tools
```

## Available Tools (~35 total)

### Workspace Management
- `affine_list_workspaces` — List all workspaces
- `affine_get_workspace` — Get workspace details
- `affine_create_workspace` — Create new workspace
- `affine_update_workspace` — Update workspace metadata
- `affine_delete_workspace` — Delete workspace

### Document Operations
- `affine_list_docs` — List documents in workspace
- `affine_get_doc` — Get document metadata
- `affine_search_docs` — Search documents
- `affine_create_doc` — Create new document (WebSocket)
- `affine_append_paragraph` — Add content to doc (WebSocket)
- `affine_publish_doc` — Make doc public
- `affine_revoke_doc` — Make doc private

### Comments & Collaboration
- `affine_list_comments` — Get doc comments
- `affine_create_comment` — Add comment
- `affine_update_comment` — Edit comment
- `affine_delete_comment` — Remove comment

### Version Control
- `affine_list_snapshots` — Get doc versions
- `affine_get_snapshot` — Get specific version
- `affine_restore_snapshot` — Restore from version

### User Management
- `affine_get_user` — Get user info
- `affine_list_workspace_members` — List members
- `affine_invite_member` — Add member
- `affine_remove_member` — Remove member

## Important Limitations

### ⚠️ Content Access Constraints

**GraphQL API (what MCP uses):**
- ✅ Document metadata (title, created, updated, etc.)
- ✅ Search snippets
- ✅ Comments
- ❌ **Full document content** (not exposed)

**WebSocket/Y.js CRDT (direct connection needed):**
- ✅ Full document content
- ✅ Real-time collaboration
- ⚠️ **Not accessible via MCP GraphQL**

**What this means:**
- MCP can **search** and **list** docs
- MCP can **read metadata** and **comments**
- MCP **cannot read full text** of documents
- For full content: need direct Y.js WebSocket client

## Use Cases (with current limitations)

### ✅ What works well
- Search documents by title/metadata
- List workspaces and docs
- Read/write comments
- Manage workspace members
- Get document structure/outline
- Publish/unpublish docs

### ❌ What doesn't work (yet)
- Read full document content
- Extract complete text for AI analysis
- Copy content between AFFiNE and code
- Full-text semantic search in doc body

## Workarounds

### For reading doc content:

1. **Export API** (if available)
```bash
# Check if AFFiNE supports export via API
curl https://devpanl.dev/affine/api/docs/{docId}/export
```

2. **Published docs** (public URLs)
```bash
# If doc is published, can fetch HTML
curl https://devpanl.dev/affine/public/{docId}
```

3. **Direct WebSocket client** (future)
```javascript
// Connect directly to Y.js CRDT
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const doc = new Y.Doc();
const provider = new WebsocketProvider(
  'wss://devpanl.dev/affine/ws',
  'doc-id',
  doc
);
```

## Shelly Integration Plan

For the multi-agent architecture:

```javascript
// Shelly can use AFFiNE MCP for:
// - List sprint docs
// - Read ADR comments
// - Check task status
// - Update design doc metadata

// Example workflow:
const sprints = await mcp.call('affine_search_docs', {
  workspace: 'dev-workspace',
  query: 'sprint'
});

for (const sprint of sprints) {
  const comments = await mcp.call('affine_list_comments', {
    docId: sprint.id
  });

  // Can see comments, but not full doc content
  // Need to use published URL or export API for content
}
```

## Configuration for Production

### Environment variables (for Shelly container)

```bash
# .env
AFFINE_BASE_URL=https://devpanl.dev/affine
AFFINE_EMAIL=shelly-agent@devpanl.dev
AFFINE_PASSWORD=${AFFINE_SHELLY_PASSWORD}

# Or with API token
AFFINE_TOKEN=${AFFINE_API_TOKEN}
```

### Docker Compose integration

```yaml
# docker-compose.prod.yml
services:
  shelly:
    # ... other config
    environment:
      - AFFINE_BASE_URL=https://devpanl.dev/affine
      - AFFINE_EMAIL=${AFFINE_EMAIL}
      - AFFINE_PASSWORD=${AFFINE_PASSWORD}
    depends_on:
      - affine
    networks:
      - agents
      - traefik
```

## Troubleshooting

### Connection issues

```bash
# Check AFFiNE is accessible
curl https://affine.lan/api/health
curl https://devpanl.dev/affine/api/health

# Test MCP config
affine-mcp doctor

# Check auth
affine-mcp status
```

### Common errors

**"Cannot connect to AFFiNE"**
- Check `baseUrl` in config
- Verify AFFiNE is running
- Check network/firewall

**"Authentication failed"**
- Verify email/password or token
- Check user exists in AFFiNE
- Try regenerating API token

**"No workspaces found"**
- User may not have access
- Create a workspace first in AFFiNE UI

## Future Enhancements

1. **Full content access** — Direct Y.js WebSocket integration
2. **Export API** — If AFFiNE adds document export endpoint
3. **Batch operations** — Read multiple docs efficiently
4. **Real-time sync** — Listen to doc changes via WebSocket

## Resources

- [AFFiNE MCP Server GitHub](https://github.com/DAWNCR0W/affine-mcp-server)
- [AFFiNE API Docs](https://affine.pro/docs/api)
- [MCP Protocol Spec](https://modelcontextprotocol.io/)
