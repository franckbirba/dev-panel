# DevPanel Widget v3 — Design Spec

## Overview

Rewrite the React DevPanel widget from a basic file-picker form into a production-grade bug reporting tool with element inspection, region-based screenshot with annotation, auto-captured debug context, and lightweight session replay.

**Goal:** Best-in-class bug reporting widget that ships as part of the `dev-panel` npm package (`dev-panel/react`). Zero config, one component, works in any React 18/19 app.

## Architecture

### Component Tree

```
src/react/
  DevPanel.jsx          — Orchestrator (state machine, mounts capture utils)
  InspectOverlay.jsx    — Full-viewport overlay, highlight elements, crosshair cursor
  RegionSelect.jsx      — Draw rectangle to crop screenshot area
  AnnotationCanvas.jsx  — Canvas overlay for arrows, circles, text on captured screenshot
  BugReportPanel.jsx    — Slide-in dark panel with auto-captured context + description
  FeaturePanel.jsx      — Simplified form (title + description, no inspect/screenshot)
  captureUtils.js       — ConsoleBuffer, NetworkInterceptor, getComponentInfo, takeScreenshot, getPerfMetrics
  sessionRecorder.js    — 30s circular buffer of DOM events (clicks, scrolls, mutations, errors)
  index.js              — Export { DevPanel }
```

### State Machine

**Bug report flow:**
```
idle → menu → inspecting → region-select → annotating → bug-report → submitting → idle
```

**Feature request flow:**
```
idle → menu → feature-panel → submitting → idle
```

Escape key moves back one step at every stage.

## Component Specs

### DevPanel.jsx (Orchestrator)

**Props:**
| Prop | Type | Default | Required |
|------|------|---------|----------|
| `apiUrl` | string | `http://localhost:3030` | no |
| `apiKey` | string | — | yes |
| `position` | `'bottom-right' \| 'bottom-left'` | `'bottom-right'` | no |

**Responsibilities:**
- Renders FAB button (floating action button)
- Manages state machine transitions
- Mounts ConsoleBuffer, NetworkInterceptor, SessionRecorder, PerfMetrics on component mount
- Detaches all capture utils on unmount
- Passes captured context down to BugReportPanel
- Handles ticket submission (POST /api/tickets)
- Shows toast feedback after submit (success/error, auto-dismiss 3s)

**Rendering by state:**
| State | Renders |
|-------|---------|
| `idle` | FAB only |
| `menu` | FAB (dark) + menu popover (Report Bug, Request Feature) |
| `inspecting` | InspectOverlay |
| `region-select` | RegionSelect |
| `annotating` | AnnotationCanvas |
| `bug-report` | BugReportPanel |
| `feature-panel` | FeaturePanel |
| `submitting` | BugReportPanel or FeaturePanel with disabled state |

### InspectOverlay.jsx

Full-viewport transparent overlay with pointer-events: none (except instruction banner).

**Behavior:**
- `mousemove` (capture phase): `document.elementFromPoint()` → highlight element with red border + semi-transparent red fill
- Elements with `[data-devtool-ignore]` attribute are skipped
- Tooltip follows cursor showing `<ComponentName>` (from React fiber) or `<tagName>`
- `click` (capture phase): preventDefault + stopPropagation, capture componentInfo via `getComponentInfo(el)`, transition to `region-select`
- `Escape`: cancel, return to menu
- Instruction banner at top center: "Click any element to inspect · Esc to cancel"

**Props:**
- `onSelect(componentInfo)` — called on element click
- `onCancel()` — called on Escape

### RegionSelect.jsx

Overlay that lets the user draw a rectangle on the page to define the screenshot crop area.

**Behavior:**
- Full-viewport overlay with semi-transparent dark background
- Mousedown starts the rectangle, mousemove expands it, mouseup finalizes
- The selected region is shown as a clear "window" through the dark overlay
- Instruction banner: "Drag to select area · Enter for full page · Esc to go back"
- Enter key: skip region select, capture full viewport
- After region defined: capture screenshot of that region via `takeScreenshot(rect)`

**Props:**
- `onCapture(screenshotBase64, rect)` — called with cropped screenshot
- `onCancel()` — back to inspecting

### AnnotationCanvas.jsx

Canvas overlay on top of the captured screenshot image for user annotations.

**Behavior:**
- Displays the captured screenshot as background
- Floating toolbar (top center): Arrow, Circle, Text, Color picker (red/yellow/blue), Undo, Done
- **Arrow tool**: click start point, drag to end point, renders arrow with head
- **Circle tool**: click center, drag to set radius, renders circle outline
- **Text tool**: click to place, inline text input, renders text at position
- All drawings use Canvas 2D API on an overlay canvas
- Undo: pop last annotation from stack
- Done: merge annotations onto screenshot canvas, export as base64 JPEG (quality 0.8)

**Props:**
- `screenshot` (string) — base64 image to annotate
- `onDone(annotatedScreenshot)` — called with final base64
- `onCancel()` — back to region-select

### BugReportPanel.jsx

Slide-in panel from the right side, dark theme, 400px wide.

**Sections (top to bottom):**

1. **Header**: "Bug Report" + close button
2. **Selected component** (if captured): `<ComponentName>`, file path, props summary
3. **Console errors** (if any): last 5 entries with level/message, color-coded
4. **Network errors** (if any): last 5 failed requests with method/url/status
5. **Performance**: LCP, CLS, FCP values with color indicators (green/yellow/red)
6. **Screenshot preview**: thumbnail of annotated screenshot (clickable to enlarge)
7. **Description** (required): textarea, placeholder "Describe the bug..."
8. **Footer**: Submit button + Cancel button

All context sections are auto-populated, user only needs to write a description.

**Props:**
- `componentInfo` — { name, file, props }
- `consoleEntries` — array of { level, message, timestamp }
- `networkErrors` — array of { method, url, status, timestamp }
- `perfMetrics` — { lcp, cls, fcp }
- `screenshot` — base64 string
- `sessionReplay` — array of events
- `onSubmit(description)` — called with user's text
- `onCancel()` — close panel
- `submitting` — boolean

### FeaturePanel.jsx

Simplified slide-in panel (same dark theme/positioning as BugReportPanel).

**Sections:**
1. **Header**: "Feature Request" + close button
2. **Title** (required): text input
3. **Description** (required): textarea
4. **Footer**: Submit + Cancel

**Props:**
- `onSubmit(title, description)` — called on submit
- `onCancel()` — close panel
- `submitting` — boolean

## Capture Utilities

### captureUtils.js

#### ConsoleBuffer
- Ring buffer, max 50 entries
- Monkey-patches `console.log`, `console.warn`, `console.error`
- Each entry: `{ level, message, timestamp }`
- `attach()` / `detach()` / `getEntries()` / `clear()`

#### NetworkInterceptor
- Ring buffer, max 50 entries
- Intercepts `globalThis.fetch` via `Object.defineProperty` getter/setter
- Records requests with `response.status >= 400`
- Each entry: `{ method, url, status, statusText, timestamp }`
- `attach()` / `detach()` / `getErrors()` / `clear()`

#### getComponentInfo(element)
- Find React fiber via `__reactFiber$*` property on DOM element
- Walk up fiber tree to find nearest function/class component
- Return: `{ name, file, props, storeSlice: null }`
- Props: shallow clone, omit children and functions, stringify objects as `[Object]`

#### takeScreenshot(rect?)
- Uses `html2canvas` to capture `document.body`
- Options: `useCORS: true, scale: 1, logging: false`
- If `rect` provided: crop canvas to that region
- Returns: base64 JPEG string (quality 0.7)
- Returns `null` on failure (silent catch)

#### getPerfMetrics()
- Uses `PerformanceObserver` API to collect Web Vitals passively
- Observes: `largest-contentful-paint`, `layout-shift`, `paint` (for FCP)
- Returns: `{ lcp: number|null, cls: number|null, fcp: number|null }`
- Accumulates CLS across all layout shifts
- Collects on mount, returns latest values on demand

### sessionRecorder.js

Circular buffer recording user interactions for the last 30 seconds.

#### Events captured:
| Event | Source | Data |
|-------|--------|------|
| `click` | `addEventListener('click', ..., true)` | `{ type, target (CSS selector), x, y, t }` |
| `scroll` | `addEventListener('scroll', ..., { passive: true, capture: true })` | `{ type, target, scrollX, scrollY, t }` |
| `input` | `addEventListener('input', ..., true)` | `{ type, target (CSS selector), t }` — no value (privacy) |
| `navigation` | `popstate` + intercept `pushState/replaceState` | `{ type, from, to, t }` |
| `mutation` | `MutationObserver({ childList: true, subtree: true })` | `{ type, added: count, removed: count, target, t }` |
| `resize` | `addEventListener('resize', ...)` (debounced 200ms) | `{ type, width, height, t }` |
| `error` | `window.addEventListener('error', ...)` | `{ type, message, filename, lineno, t }` |

#### Design:
- Max 500 events or 30 seconds (whichever fills first)
- Timestamps are relative to capture time (negative milliseconds, e.g. `-2500` = 2.5s ago)
- `attach()` / `detach()` / `getSessionReplay()` / `clear()`
- `getSessionReplay()` returns a copy of the buffer with timestamps converted to relative

#### Privacy:
- No input values recorded (just field selector)
- Password fields: not even the selector contains identifying info
- No mouse movement tracking
- No text content from mutations (just node counts)

## API Payload

The ticket submission payload sent to `POST /api/tickets`:

```json
{
  "type": "bug",
  "title": "<ComponentName>: <first line of description>",
  "description": "User's description text",
  "screenshot": "data:image/jpeg;base64,...",
  "created_by": "user",
  "context": {
    "url": "https://app.example.com/dashboard",
    "userAgent": "Mozilla/5.0 ...",
    "viewport": { "width": 1440, "height": 900 },
    "timestamp": 1712833200000,
    "component": {
      "name": "DataTable",
      "file": "src/components/DataTable.jsx",
      "props": { "sortBy": "date", "pageSize": 25 }
    },
    "console": [
      { "level": "error", "message": "TypeError: Cannot read property 'map' of undefined", "timestamp": "2026-04-11T08:30:00Z" }
    ],
    "network": [
      { "method": "GET", "url": "/api/data?page=2", "status": 500, "statusText": "Internal Server Error", "timestamp": "2026-04-11T08:29:58Z" }
    ],
    "performance": { "lcp": 1200, "cls": 0.05, "fcp": 800 },
    "sessionReplay": [
      { "type": "click", "target": "button.load-more", "x": 450, "y": 320, "t": -5000 },
      { "type": "error", "message": "TypeError: Cannot read property 'map' of undefined", "filename": "DataTable.jsx", "lineno": 42, "t": -4800 },
      { "type": "scroll", "target": "div.table-container", "scrollX": 0, "scrollY": 1200, "t": -3000 },
      { "type": "click", "target": "button.submit", "x": 200, "y": 600, "t": -1000 }
    ]
  }
}
```

For **feature requests**, the payload is simpler:

```json
{
  "type": "feature",
  "title": "User-provided title",
  "description": "User-provided description",
  "created_by": "user",
  "context": {
    "url": "https://app.example.com/dashboard",
    "userAgent": "Mozilla/5.0 ...",
    "viewport": { "width": 1440, "height": 900 },
    "timestamp": 1712833200000
  }
}
```

## Backend Changes

**None required.** The existing `context` TEXT field stores JSON and already accepts arbitrary structure. The `screenshot` BLOB field already handles base64 images. The session replay data fits within the context JSON. No schema migration needed.

## Dependencies

**New:**
- `html2canvas` — screenshot capture (adds ~40KB gzipped)

**Existing (unchanged):**
- `react` (peer dep, ^18.0.0 || ^19.0.0)

**Not added:**
- No `rrweb` (custom lightweight recorder instead)
- No `getDisplayMedia` (html2canvas is more seamless, no permission popup)
- No `lucide-react` or icon library (inline SVG icons to keep bundle small)

## Styling

- All inline styles (no CSS modules, no external stylesheets) — same pattern as current widget
- Dark theme for panels: `#1a1a2e` background, `#e0e0e0` text
- Accent colors: red `#ef4444` (bugs), indigo `#6366f1` (features), green `#10b981` (success)
- `data-devtool-ignore` attribute on all DevPanel DOM nodes (prevents self-inspection)
- `z-index: 99999` for overlays, `99998` for highlight layer
- Slide-in animation for panels, fade-in for menus
- All elements use `box-sizing: border-box`

## Edge Cases

- **No React fiber found**: fallback to `tagName` for component info
- **html2canvas fails**: send ticket without screenshot, show warning in panel
- **Session recorder buffer overflow**: oldest events are discarded (ring buffer)
- **Multiple DevPanel instances**: not supported, warn in console if detected
- **SSR**: component renders null on server, all captures are client-only
- **Strict Mode double-mount**: capture utils handle attach/detach idempotently

## Out of Scope (v3)

- Session replay player/viewer (events are JSON-readable by devs and AI agents)
- Video recording
- Offline ticket queue
- Custom themes/branding
- Non-React frameworks (Vue, vanilla JS)
