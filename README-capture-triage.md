# Feature Implementation: Real-time Capture Triage

## Summary

This implementation adds real-time and batch processing for capture triage to meet the requirement of processing captures in <30 minutes.

## Changes Made

### 1. Capture Triage Handler (`src/worker/handlers/capture-triage.js`)

Created a new handler that:
- Processes individual captures immediately when created
- Runs batch processing every 30 minutes for safety
- Checks content quality, age, and duplicates
- Promotes valid captures to Plane work items
- Drops invalid/duplicate captures with reasons
- Logs all decisions for audit trail

### 2. Worker Cron Integration (`src/worker/crons.js`)

Added a new cron job:
- Runs every 30 minutes (`*/30 * * * *`)
- Processes any captures that weren't handled immediately
- Ensures <30 minute processing SLA

### 3. Immediate Processing (`src/server/captures.js`)

Modified capture creation:
- Enqueues immediate triage job on creation
- Ensures real-time processing for most captures
- Fallback to batch processing if immediate fails

### 4. Worker Integration (`src/worker/index.js`)

Added handler registration:
- Routes `capture_triage` jobs to the new handler
- Supports both individual and batch processing modes

## How It Works

1. **Real-time Processing**: When a capture is created, an immediate triage job is enqueued
2. **Batch Safety Net**: Every 30 minutes, any remaining unprocessed captures are handled
3. **Quality Control**: Captures are validated for content quality and age
4. **Deduplication**: Checked against existing backlog before promotion
5. **Audit Trail**: All decisions logged for transparency and rollback capability

## Testing

Unit tests created in `src/worker/handlers/__tests__/capture-triage.test.js`

Documentation in `docs/capture-triage.md`

## Verification

To verify the implementation:

1. Create a new capture via widget or dashboard
2. Check that a triage job is immediately enqueued
3. Verify the capture is processed within seconds
4. Confirm batch processing runs every 30 minutes
5. Check auto-decision logs for audit trail

This implementation satisfies all acceptance criteria:
- ✅ Capture created → triaged in <30 min in normal conditions
- ✅ No promotion without criteria
- ✅ Each decision traced with message in Shelly thread
- ✅ Tests on hook→enqueue and sweep idempotence