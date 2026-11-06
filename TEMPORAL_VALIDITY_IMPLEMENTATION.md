# Temporal Validity Implementation for Memories and Subject Links

## Overview

This implementation adds temporal validity windows to the `memories` and `subject_links` tables to support time-based expiration of facts in the Shelly memory system.

## Changes Made

### 1. Database Migration (014-memory-temporal-validity.sql)

Added two new columns to both `memories` (PostgreSQL) and `subject_links` (SQLite) tables:

- `valid_from` (TIMESTAMPTZ/DATETIME): When the fact became true (default: created_at/current timestamp)
- `valid_to` (TIMESTAMPTZ/DATETIME): When the fact ceased to be true (NULL = still valid)

### 2. PostgreSQL Functions (src/server/pg.js)

Updated the PostgreSQL memory functions to support temporal validity:

- `memoryInsert`: Added `valid_from` and `valid_to` parameters
- `memorySearchSqlWithValidity`: New function that excludes expired facts by default and supports `as_of` parameter for historical queries
- `memoryList`: Updated to support temporal validity filtering
- `memorySupersede`: New helper function to expire a memory by setting its `valid_to` to current time

### 3. MCP Server Tools (src/mcp/server.js)

Updated the MCP tools to expose temporal validity functionality:

- `memory_write`: Added `valid_from`, `valid_to`, and `supersedes_id` parameters
- `memory_search`: Added `as_of` parameter for historical queries
- `memory_list`: Added `as_of` parameter for historical queries

### 4. SQLite Schema (src/server/db.js)

Updated the `subject_links` table schema to include `valid_from` and `valid_to` columns.

### 5. Tests (tests/server/temporal-validity.test.js)

Created comprehensive tests for temporal validity functionality:

- Insert memories with temporal validity
- List/search current memories (excluding expired)
- Query historical state with `as_of` parameter
- Test memory superseding functionality

## Usage Examples

### Writing a Memory with Temporal Validity

```javascript
const id = await memoryInsert({
  namespace: 'test',
  agent: 'builder',
  kind: 'decision',
  title: 'My Decision',
  content: 'This is my decision content',
  embedding: Array(1024).fill(0.01),
  valid_from: new Date().toISOString(),
  valid_to: new Date(Date.now() + 86400000).toISOString() // Expires in 24 hours
});
```

### Superseding a Memory

```javascript
// This will set the valid_to of the old memory to now
await memorySupersede(oldMemoryId);
```

### Searching with Temporal Filters

```javascript
// Current memories only (default behavior)
const currentMemories = await memoryList({ 
  namespace: 'test',
  limit: 10
});

// Historical query as of a specific time
const historicalMemories = await memoryList({ 
  namespace: 'test',
  limit: 10,
  as_of: '2026-01-01T12:00:00Z'
});
```

## Backward Compatibility

All changes maintain backward compatibility:

- Existing functions continue to work as before
- New parameters are optional
- Default behavior excludes expired facts from current queries
- Legacy `memorySearchSql` function maintained for compatibility

## Performance Considerations

Added indexes for efficient temporal queries:
- `memories_validity_window` on `(valid_from, valid_to)`
- `memories_namespace_validity` on `(namespace, valid_from, valid_to)`