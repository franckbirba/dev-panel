# Telegram Multi TTL Implementation

This document describes the Time-To-Live (TTL) implementation added to prevent backlog accumulation in the Telegram multi-channel service.

## Problem

On August 11, 2026, the `telegram-multi` service had been offline for approximately 3 months. When it restarted, it began draining its backlog which included:
- Historical captures from the project=demo era
- Questions from orphaned conversations
- A dangerous `rm -rf /` fixture from May that was still pending

This caused Franck to be spammed and exposed to destructive commands, leading to the service being STOPPED in containment.

## Solution

We implemented a TTL mechanism that automatically drops messages and denies permissions that have been queued for more than 6 hours.

## Changes Made

### 1. Added TTL Constants

```typescript
// TTL for outbound messages and permissions (6 hours)
const MESSAGE_TTL_HOURS = 6
const MESSAGE_TTL_MS = MESSAGE_TTL_HOURS * 60 * 60 * 1000
```

### 2. Message Expiration Check

Added `isMessageExpired()` function to check if messages are older than the TTL:

```typescript
function isMessageExpired(createdAt: number): boolean {
  return (Date.now() - createdAt) > MESSAGE_TTL_MS
}
```

### 3. Enhanced `pruneExpired` Function

Modified the existing `pruneExpired` function to also remove pending permissions older than the TTL:

```typescript
function pruneExpired(a: Access): boolean {
  const now = Date.now()
  let changed = false
  
  // Prune expired pending permissions (original behavior)
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  
  // Prune pending permissions that are older than TTL
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.createdAt < (now - MESSAGE_TTL_MS)) {
      delete a.pending[code]
      changed = true
      log(`telegram-multi: pruned expired pending permission ${code} (older than ${MESSAGE_TTL_HOURS} hours)`)
    }
  }
  
  return changed
}
```

### 4. Pre-send Validation

Added expiration checks before sending messages and permission requests:

```typescript
// Check if message is expired before sending
const messageTimestamp = Date.now()
if (isMessageExpired(messageTimestamp)) {
  log(`telegram-multi: dropping expired message to ${chat_id} (older than ${MESSAGE_TTL_HOURS} hours)`)
  return { content: [{ type: 'text', text: 'Message dropped (expired)' }] }
}
```

### 5. Auto-Denial of Expired Permissions

Permission requests that are too old are automatically denied:

```typescript
// Check if permission request is expired before sending
if (isMessageExpired(permissionTimestamp)) {
  log(`telegram-multi: dropping expired permission request ${request_id} (older than ${MESSAGE_TTL_HOURS} hours)`)
  // Auto-deny the permission request
  void mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id, behavior: 'deny' },
  })
  pendingPermissions.delete(request_id)
  return
}
```

### 6. Periodic Cleanup

Added a periodic cleanup function that runs every 30 minutes to remove stale permissions:

```typescript
// Periodic cleanup of expired pending permissions
function cleanupExpiredPermissions(): void {
  const now = Date.now()
  let expiredCount = 0
  
  for (const [requestId, permission] of pendingPermissions.entries()) {
    // Check if permission was created more than TTL ago
    const permissionAge = now - (permission as any).timestamp || now // fallback to now if no timestamp
    if (permissionAge > MESSAGE_TTL_MS) {
      log(`telegram-multi: auto-denying expired permission request ${requestId}`)
      // Auto-deny the permission request
      void mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: requestId, behavior: 'deny' },
      })
      pendingPermissions.delete(requestId)
      expiredCount++
    }
  }
  
  if (expiredCount > 0) {
    log(`telegram-multi: cleaned up ${expiredCount} expired permission requests`)
  }
}

// Run cleanup every 30 minutes
setInterval(cleanupExpiredPermissions, 30 * 60 * 1000).unref()
```

## Backlog Purge Script

A purge script was created at `scripts/purge-telegram-backlog.js` to clean up existing backlog:

1. Removes entries from the PostgreSQL `telegram_outbound` table older than August 11, 2026
2. Deletes files in the inbox and approved directories that were modified before the cutoff date
3. Removes pending permissions in `access.json` that were created before the cutoff date

## Usage

### Running the Purge Script

```bash
# Dry run to see what would be purged
node scripts/purge-telegram-backlog.js --dry-run

# Actual purge
node scripts/purge-telegram-backlog.js
```

### Restarting the Service

After running the purge script, the service can be safely restarted:

```bash
sudo systemctl restart shelly.service
```

## Verification

The TTL functionality was verified with a test script at `scripts/test-ttl-functionality.js`.

## Future Improvements

1. Add metrics collection for expired messages and permissions
2. Implement more granular TTL settings per message type
3. Add alerting for high volumes of expired messages