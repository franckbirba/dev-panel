# Evening Digest Implementation Summary

## Overview
Implemented the evening digest feature as requested in work item 5ba25cff-513f-40cb-9fc9-de5d186606b2. This feature provides a daily recap at 19:00 Europe/Paris mirroring the deterministic approach of the existing morning digest.

## Changes Made

### 1. Extended shelly-digest handler (`src/worker/handlers/shelly-digest.js`)
- Added `digest_type` parameter support (defaults to 'morning')
- Implemented dual-mode logic for morning vs evening digests
- Evening digest includes:
  - PRs merged during the day (using workflow instances with status 'done')
  - Items that passed Blocked status
  - Current fleet status (running, blocked, awaiting counts)
  - Reaped instances count (placeholder for future integration)
- Maintains zero-token LLM consumption principle
- Sections automatically omitted when empty to reduce noise

### 2. Added evening digest cron job (`src/worker/crons.js`)
- New cron job `shelly:evening-digest` scheduled for 19:00 Europe/Paris
- Uses same handler as morning digest but with `digest_type: 'evening'`
- Configurable via `EVENING_DIGEST_CRON` environment variable
- Same priority level as morning digest (P2)

### 3. Updated worker index (`src/worker/index.js`)
- Updated comment to reflect support for both morning and evening digests

### 4. Added comprehensive tests
- Unit tests for shelly-digest handler covering both digest types
- Configuration tests for cron jobs validation

## Technical Details

### Data Sources
- **Workflow Instances**: Used to determine PR merges, status changes, and fleet metrics
- **BullMQ Jobs**: For failed job counts (mirroring morning digest approach)
- **Database Queries**: Direct SQLite queries for deterministic results

### Key Features
- **Deterministic**: No LLM tokens consumed, purely data-driven
- **Time-aware**: Evening digest covers activity since morning digest (07:00 onward)
- **Adaptive Content**: Empty sections automatically filtered out
- **Robust Error Handling**: Graceful degradation if any data source unavailable
- **Consistent Formatting**: Follows existing digest presentation style

### Future Improvements
- Integrate with budget guard for spending reports (as mentioned in requirements)
- Implement proper reaper integration for accurate instance reset counts
- Add deployment metrics if available

## Testing
Unit tests cover:
- Morning digest generation (backward compatibility)
- Evening digest generation with all sections
- Error handling for database failures
- Empty section filtering
- Cron configuration validation

## Deployment
No additional deployment steps required. The implementation follows existing patterns and leverages current infrastructure.