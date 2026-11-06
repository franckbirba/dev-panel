# Capture Triage Implementation Summary

## Objective
Implement real-time triage of captures with event-driven processing + 30-minute scanning to ensure captures are processed in <30 minutes.

## Files Modified

### 1. New Files Created

1. **`src/worker/handlers/capture-triage.js`** - Main triage logic handler
2. **`src/worker/handlers/__tests__/capture-triage.test.js`** - Unit tests
3. **`src/worker/handlers/__tests__/integration-test.js`** - Integration tests
4. **`docs/capture-triage.md`** - Documentation
5. **`README-capture-triage.md`** - Implementation summary

### 2. Existing Files Modified

1. **`src/worker/crons.js`** - Added 30-minute batch scanner cron job
2. **`src/worker/index.js`** - Added handler registration for capture triage
3. **`src/server/captures.js`** - Added immediate triage job enqueue on capture creation

## Implementation Details

### Event-Driven Processing
- When a capture is created, immediately enqueue a triage job
- Worker processes individual captures in real-time
- Ensures sub-second to minute response times

### Batch Processing Safety Net
- Cron job runs every 30 minutes (`*/30 * * * *`)
- Processes any captures that weren't handled immediately
- Guarantees <30 minute SLA even under failure conditions

### Processing Logic
1. **Validation**: Check content quality (>10 chars) and age (<72 hours)
2. **Deduplication**: Fuzzy search against existing backlog (80% similarity threshold)
3. **Promotion**: Valid captures promoted to Plane work items with criteria
4. **Rejection**: Invalid/duplicate captures dropped with logged reasons
5. **Logging**: All decisions recorded in auto_decisions table

### Acceptance Criteria Compliance

✅ **Capture créée → triée en <30 min en conditions normales**
- Real-time processing typically within seconds
- Batch processing ensures <30 minute guarantee

✅ **Aucune promotion sans critères d'acceptation**
- Content quality checks enforced
- Age limits prevent stale captures
- Duplicate detection prevents redundancy

✅ **Chaque décision tracée (auto_decisions) + message dans le fil Shelly**
- All decisions logged with context
- Notifications sent for promotions and duplicates
- Full audit trail for rollback capability

✅ **Tests sur le chemin hook→enqueue et sur l'idempotence du balayage**
- Unit tests cover immediate processing path
- Integration tests verify batch processing
- Handler designed to be idempotent

## Technical Approach

The implementation follows the existing codebase patterns:

1. **Handler Pattern**: Like other worker handlers (pr_scanner, shelly_digest)
2. **BullMQ Integration**: Uses existing queue infrastructure
3. **Cron System**: Leverages established cron job framework
4. **Audit Logging**: Integrates with auto_decisions system
5. **Notification System**: Uses existing notifyJob infrastructure

## Deployment Impact

- No breaking changes to existing functionality
- Backward compatible with current capture system
- Self-healing through batch processing safety net
- Comprehensive logging for monitoring and debugging

## Monitoring

- Worker logs show processing statistics
- Failed captures remain for manual review
- Auto-decision logs provide complete audit trail
- Telegram notifications maintain visibility

This implementation fully addresses the work item requirements while maintaining system reliability and providing comprehensive observability.