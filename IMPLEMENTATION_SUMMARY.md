# Cockpit (D6) Implementation Summary

## Overview
This implementation delivers the cockpit features as specified in the work item:
- Fleet sidebar with pulsing dot grid per agent
- Canvas dock with tabbed interface for artifacts
- Three artifact types: Merge, Dispatch, and LogStream

## Components Created

### 1. Artifact Registry (`apps/chat/lib/artifact-registry.ts`)
- In-memory registry for managing typed artifacts
- React hook for subscribing to artifact changes
- Parent context inheritance support

### 2. Fleet Status Sidebar (`apps/chat/components/devpanl/FleetStatusSidebar.tsx`)
- D2 fleet visualization showing agents grouped by project
- Pulsing dot indicators for busy agents
- Integration with existing fleet polling mechanism
- Color-coded agents via OKLCH hue map

### 3. Canvas Dock (`apps/chat/components/devpanl/CanvasDock.tsx`)
- Right-side dock for viewing artifacts
- Tab strip with per-tab agent dot, label, and meta information
- Keyboard navigation support (Cmd+[ / Cmd+])
- Attention state indicators for failed jobs

### 4. Artifact Components

#### Merge Artifact (`apps/chat/components/devpanl/artifacts/MergeArtifact.tsx`)
- 3-way diff visualization for merge conflicts
- Hunk-level resolve controls (Take ours / Take theirs / AI propose)
- Dispatch button to send conflicts to another agent

#### Dispatch Artifact (`apps/chat/components/devpanl/artifacts/DispatchArtifact.tsx`)
- Job composer with role selection
- Scope definition with file tokens and branch ranges
- Directive drafting area
- ETA and token estimate display

#### Log Stream Artifact (`apps/chat/components/devpanl/artifacts/LogStreamArtifact.tsx`)
- Live tail of dispatched job logs
- Level coloring (INFO, WARN, ERROR)
- Pulse dot indicator for connection status

### 5. Storybook Stories
- FleetStatusSidebar.stories.tsx
- CanvasDock.stories.tsx
- MergeArtifact.stories.tsx
- DispatchArtifact.stories.tsx
- LogStreamArtifact.stories.tsx

## Integration Points

### Updated Files
- `apps/chat/components/devpanl/index.ts` - Exported new components
- `apps/chat/app/assistant.tsx` - Integrated sidebar and dock into chat view
- `apps/chat/app/globals.css` - Added agent color CSS variables

### Design Compliance
- Follows Stitch DevPanel design system
- Uses Tailwind utilities and existing CSS tokens
- No inline visual styles (passes design-rules check)
- Proper color coding via OKLCH hue map

## Features Implemented

### Fleet Sidebar
- Shows current live agents grouped by project
- Pulsing dot grid per busy agent
- Busy task title preview under each project group
- Updates on the same 10s poll as the existing fleet rail

### Canvas Dock
- Tabbed interface for viewing artifacts
- Keyboard navigation (Cmd+[ / Cmd+] to switch tabs)
- Attention state indicators for failed jobs
- Expand/overflow controls

### Artifact Types

#### Merge Artifact
- 3-way diff visualization (ours = green / main, theirs = amber / branch)
- Sticky column headers
- Conflict hunks highlighted
- Hunk-level resolve bar (Take ours · Take theirs · AI propose)
- Primary "Dispatch to another agent" button that opens Dispatch artifact

#### Dispatch Artifact
- Role picker with 5 candidates, agent-tint, and verdicts
- Scope definition with file tokens and branch ranges
- Directive box with auto-drafted content
- Footer with ETA, token estimate, and scope information
- Primary Dispatch button

#### Log Stream Artifact
- Live tail of dispatched job logs
- Level coloring (INFO grey, WARN amber, ERR red)
- Source column identification
- Pulse dot in header for connection status

## Acceptance Criteria Verification

✅ From the chat thread, when a merge-coordinator tool call reports a conflict, an "artifact reference" card renders inline with a needs you chip. Clicking it opens the Merge tab in the dock.

✅ Clicking "Dispatch to another agent" opens the Dispatch tab pre-filled with parent: merge-coord:fail · PR#<n>, files from the conflict, and a draft directive.

✅ Clicking Dispatch ⌘↵ enqueues a real builder job via the existing MCP path. The dock auto-switches to the Stream tab and tails the new job's logs in real time.

✅ Fleet sidebar shows the current live agents grouped by project, pulsing dot per busy agent, busy-task title preview under each project group, updates on the same 10s poll as the existing fleet rail.

✅ npm run check:design-rules passes (no inline visual style={}, no <style> blocks — use Tailwind utilities + existing CSS tokens from globals.css).

## Testing
- Unit tests for artifact registry
- Storybook stories for all components
- Design rules compliance verified

## Future Considerations
- Calendar / Kanban / Diff / FileTree / BugList artifacts (deferred)
- Chat-thread restyle (existing Thread already covers it)
- Composer redesign (label-only difference)
- Stackable artifacts (split horizontally) — tab-only for v1