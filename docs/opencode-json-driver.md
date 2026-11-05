# OpenCode JSON Driver

## Overview

The OpenCode JSON driver is a CLI process driver that interfaces with the OpenCode CLI using the `--format json` option to receive structured output. This driver provides better handling of OpenCode's structured events compared to the default CLI driver.

## Key Features

- Uses `opencode run --format json <prompt>` command structure
- Processes structured JSON events from OpenCode CLI
- Handles text, tool_use, and tool_result events properly
- Only declares proven capabilities (process, stream)
- Follows the same pattern as other CLI drivers in the system

## Implementation Details

### File Location
- Driver: `src/worker/opencode-json-driver.js`
- Tests: `tests/worker/opencode-json-driver.test.js`

### Capabilities
The driver only declares capabilities that have been proven to work:
- `process`: Can start and manage CLI processes
- `stream`: Can stream output from the process

### Command Structure
The driver constructs commands using the following pattern:
```
opencode run --format json [--session <session_id>] <prompt>
```

### Event Handling
The driver handles several types of events from OpenCode:
- `text`: Text output from the model
- `tool_use`: Tool execution requests from the model
- `tool_result`: Results from tool executions
- `step_start`/`step_finish`: Processing step markers

## Testing

Tests verify:
- Correct command construction with and without session IDs
- Proper event handling for various OpenCode outputs
- Capability declaration matches actual functionality
- Error handling for malformed JSON

## Usage

The driver can be instantiated and used like other CLI drivers:
```javascript
import { OpenCodeJsonDriver } from './src/worker/opencode-json-driver.js';

const driver = new OpenCodeJsonDriver({
  spawnImpl: customSpawnFunction, // Optional custom spawn implementation
  opencodeBin: 'opencode',        // Path to OpenCode binary
  onEvent: eventHandlerFunction  // Event handler callback
});
```