# Changelog - Telegram Multi TTL Implementation

## fix(telegram): Add TTL to prevent backlog accumulation

### Problem
After 3 months of downtime, restarting telegram-multi caused a massive backlog dump to Franck's chat, including historical captures and a dangerous `rm -rf /` command that remained pending since May. The service was stopped in containment to prevent further spam.

### Solution
Implemented Time-To-Live (TTL) functionality to automatically drop messages and deny permissions that have been queued for more than 6 hours.

### Changes

#### Core Server Modifications (`plugins/telegram-multi/server.ts`)

1. **Added TTL constants:**
   ```typescript
   const MESSAGE_TTL_HOURS = 6
   const MESSAGE_TTL_MS = MESSAGE_TTL_HOURS * 60 * 60 * 1000
   ```

2. **Enhanced `pruneExpired` function:**
   - Maintains original behavior for `expiresAt` based expiration
   - Adds additional pruning for permissions older than TTL based on `createdAt`

3. **Added `isMessageExpired` helper function:**
   - Checks if a message timestamp is older than the TTL

4. **Pre-send validation:**
   - Messages are checked for expiration before sending
   - Expired messages are dropped with a log entry
   - Expired file attachments are skipped

5. **Auto-denial of expired permission requests:**
   - Permission requests older than TTL are automatically denied
   - Notification sent to Claude indicating denial

6. **Periodic cleanup function:**
   - Runs every 30 minutes to remove stale pending permissions
   - Auto-denies expired permissions with proper notifications

7. **Enhanced permission tracking:**
   - Added timestamp field to permission objects for TTL tracking

#### Scripts

1. **Backlog purge script (`scripts/purge-telegram-backlog.js`):**
   - Cleans up existing backlog from PostgreSQL, file spools, and pending permissions
   - Supports dry-run mode for verification
   - Removes entries older than August 11, 2026

2. **Test script (`scripts/test-ttl-functionality.js`):**
   - Verifies implementation correctness
   - Checks for proper code modifications
   - Validates clean state

3. **Unit tests (`plugins/telegram-multi/__tests__/ttl.test.js`):**
   - Tests core TTL functionality concepts

#### Documentation

1. **Implementation README (`plugins/telegram-multi/README-TTL.md`):**
   - Detailed explanation of the problem and solution
   - Technical documentation of all changes
   - Usage instructions

### Verification

- Executed purge script in dry-run mode to verify no unintended deletions
- Ran actual purge to clean existing backlog
- Verified server code modifications with test script
- Created unit tests to validate core concepts

### Result

- Service can be safely restarted without backlog spam
- Future messages older than 6 hours will be automatically dropped
- Expired permission requests will be auto-denied
- No more dangerous commands will reach users after extended downtime

Fixes the immediate issue and prevents recurrence.