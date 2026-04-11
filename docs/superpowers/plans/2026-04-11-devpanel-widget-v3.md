# DevPanel Widget v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the DevPanel React widget into a production-grade bug reporting tool with element inspection, annotatable region screenshots, auto-captured debug context, and lightweight session replay.

**Architecture:** State-machine-driven orchestrator (`DevPanel.jsx`) renders one of 6 sub-components based on current mode. Capture utilities (console, network, perf, session) run passively in background via refs. All new files are pure ESM in `src/react/`. No backend changes needed — enriched context goes into the existing `context` JSON field.

**Tech Stack:** React 18/19, html2canvas, Canvas 2D API, PerformanceObserver, MutationObserver

**Spec:** `docs/superpowers/specs/2026-04-11-devpanel-widget-v3-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/react/captureUtils.js` | Create | ConsoleBuffer, NetworkInterceptor, getComponentInfo, takeScreenshot, getPerfMetrics |
| `src/react/sessionRecorder.js` | Create | SessionRecorder class — 30s circular buffer of DOM events |
| `src/react/InspectOverlay.jsx` | Create | Full-viewport overlay, highlight elements on hover, capture component info on click |
| `src/react/RegionSelect.jsx` | Create | Draw crop rectangle on page, capture region screenshot |
| `src/react/AnnotationCanvas.jsx` | Create | Canvas annotation layer (arrows, circles, text) on screenshot |
| `src/react/BugReportPanel.jsx` | Create | Slide-in dark panel showing auto-captured context + description form |
| `src/react/FeaturePanel.jsx` | Create | Simplified slide-in panel for feature requests (title + description) |
| `src/react/DevPanel.jsx` | Rewrite | State machine orchestrator, mounts capture utils, handles submission |
| `src/react/index.js` | Keep | No change needed — already exports `{ DevPanel }` |
| `package.json` | Modify | Add `html2canvas` dependency |

---

## Task 1: Add html2canvas dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install html2canvas**

```bash
cd /Users/franckbirba/DEV/dev-panel && npm install html2canvas
```

- [ ] **Step 2: Verify install**

```bash
node -e "import('html2canvas').then(m => console.log('ok:', typeof m.default))"
```

Expected: `ok: function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add html2canvas for screenshot capture"
```

---

## Task 2: Create captureUtils.js

**Files:**
- Create: `src/react/captureUtils.js`

- [ ] **Step 1: Create captureUtils.js with all 5 utilities**

```js
import html2canvas from 'html2canvas';

// ============================================================================
// ConsoleBuffer — ring buffer intercepting console.log/warn/error
// ============================================================================

export class ConsoleBuffer {
  constructor(maxSize = 50) {
    this._max = maxSize;
    this._entries = [];
    this._originals = {};
    this._attached = false;
  }

  attach() {
    if (this._attached) return;
    this._attached = true;
    ['log', 'warn', 'error'].forEach((level) => {
      const original = console[level];
      this._originals[level] = typeof original === 'function' ? original.bind(console) : null;
      console[level] = (...args) => {
        this._entries.push({ level, message: args.map(String).join(' '), timestamp: new Date().toISOString() });
        if (this._entries.length > this._max) this._entries.shift();
        if (typeof this._originals[level] === 'function') this._originals[level](...args);
      };
    });
  }

  detach() {
    if (!this._attached) return;
    ['log', 'warn', 'error'].forEach((level) => {
      if (this._originals[level]) console[level] = this._originals[level];
    });
    this._originals = {};
    this._attached = false;
  }

  getEntries() { return [...this._entries]; }
  clear() { this._entries = []; }
}

// ============================================================================
// NetworkInterceptor — intercepts fetch, records status >= 400
// ============================================================================

export class NetworkInterceptor {
  constructor(maxSize = 50) {
    this._max = maxSize;
    this._errors = [];
    this._underlying = null;
    this._descriptor = null;
    this._attached = false;
  }

  attach() {
    if (this._attached) return;
    this._attached = true;
    this._underlying = globalThis.fetch.bind(globalThis);
    this._descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

    const self = this;
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      enumerable: true,
      get() {
        return async function interceptedFetch(...args) {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
          const method = args[1]?.method || 'GET';
          const response = await self._underlying(...args);
          if (response.status >= 400) {
            self._errors.push({ method, url, status: response.status, statusText: response.statusText, timestamp: new Date().toISOString() });
            if (self._errors.length > self._max) self._errors.shift();
          }
          return response;
        };
      },
      set(newFetch) {
        self._underlying = typeof newFetch === 'function' ? newFetch.bind(globalThis) : newFetch;
      },
    });
  }

  detach() {
    if (!this._attached) return;
    if (this._descriptor) {
      Object.defineProperty(globalThis, 'fetch', this._descriptor);
    } else {
      delete globalThis.fetch;
      globalThis.fetch = this._underlying;
    }
    this._underlying = null;
    this._descriptor = null;
    this._attached = false;
  }

  getErrors() { return [...this._errors]; }
  clear() { this._errors = []; }
}

// ============================================================================
// getComponentInfo — walk React fiber tree from DOM element
// ============================================================================

function getReactFiber(element) {
  if (!element) return null;
  const key = Object.keys(element).find((k) => k.startsWith('__reactFiber$'));
  return key ? element[key] : null;
}

function safeCloneProps(props) {
  if (!props) return {};
  const clone = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children') continue;
    if (typeof value === 'function') continue;
    if (typeof value === 'object' && value !== null) {
      clone[key] = '[Object]';
    } else {
      clone[key] = value;
    }
  }
  return clone;
}

export function getComponentInfo(element) {
  const fallback = { name: element?.tagName || 'UNKNOWN', file: null, props: {} };
  try {
    let fiber = getReactFiber(element);
    if (!fiber) return fallback;
    let current = fiber;
    while (current) {
      if (typeof current.type === 'function') {
        const name = current.type.displayName || current.type.name || 'Anonymous';
        const file = current._debugSource?.fileName || null;
        const props = safeCloneProps(current.memoizedProps);
        return { name, file, props };
      }
      current = current.return;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

// ============================================================================
// takeScreenshot — capture viewport or region via html2canvas
// ============================================================================

export async function takeScreenshot(rect) {
  try {
    const canvas = await html2canvas(document.body, {
      useCORS: true,
      scale: 1,
      logging: false,
      width: Math.min(window.innerWidth, 1920),
    });
    if (rect) {
      const cropped = document.createElement('canvas');
      cropped.width = rect.width;
      cropped.height = rect.height;
      const ctx = cropped.getContext('2d');
      ctx.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
      return cropped.toDataURL('image/jpeg', 0.7);
    }
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

// ============================================================================
// getPerfMetrics — passive Web Vitals collection
// ============================================================================

export class PerfMetrics {
  constructor() {
    this._lcp = null;
    this._cls = 0;
    this._fcp = null;
    this._observers = [];
  }

  attach() {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      const lcpObs = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) this._lcp = Math.round(entries[entries.length - 1].startTime);
      });
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });
      this._observers.push(lcpObs);
    } catch {}

    try {
      const clsObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) this._cls += entry.value;
        }
      });
      clsObs.observe({ type: 'layout-shift', buffered: true });
      this._observers.push(clsObs);
    } catch {}

    try {
      const fcpObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') {
            this._fcp = Math.round(entry.startTime);
          }
        }
      });
      fcpObs.observe({ type: 'paint', buffered: true });
      this._observers.push(fcpObs);
    } catch {}
  }

  detach() {
    this._observers.forEach((obs) => obs.disconnect());
    this._observers = [];
  }

  getMetrics() {
    return {
      lcp: this._lcp,
      cls: Math.round(this._cls * 1000) / 1000,
      fcp: this._fcp,
    };
  }
}
```

- [ ] **Step 2: Verify the file is valid ESM**

```bash
node -e "import('./src/react/captureUtils.js').then(m => console.log(Object.keys(m)))"
```

Expected: `['ConsoleBuffer', 'NetworkInterceptor', 'getComponentInfo', 'takeScreenshot', 'PerfMetrics']`

- [ ] **Step 3: Commit**

```bash
git add src/react/captureUtils.js
git commit -m "feat(react): add capture utilities — console, network, perf, screenshot, component info"
```

---

## Task 3: Create sessionRecorder.js

**Files:**
- Create: `src/react/sessionRecorder.js`

- [ ] **Step 1: Create sessionRecorder.js**

```js
// ============================================================================
// SessionRecorder — 30s circular buffer of DOM events
// ============================================================================

function getCssSelector(el) {
  if (!el || el === document.body) return 'body';
  if (el.id) return `#${el.id}`;
  const tag = el.tagName?.toLowerCase() || 'unknown';
  const classes = el.className && typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
    : '';
  return tag + classes;
}

export class SessionRecorder {
  constructor({ maxEvents = 500, maxAge = 30000 } = {}) {
    this._maxEvents = maxEvents;
    this._maxAge = maxAge;
    this._events = [];
    this._attached = false;
    this._listeners = [];
    this._observer = null;
    this._origPushState = null;
    this._origReplaceState = null;
    this._resizeTimer = null;
  }

  attach() {
    if (this._attached) return;
    this._attached = true;

    // Click
    const onClick = (e) => {
      this._push({ type: 'click', target: getCssSelector(e.target), x: e.clientX, y: e.clientY });
    };
    document.addEventListener('click', onClick, true);
    this._listeners.push(['click', onClick, true]);

    // Scroll (debounced by passive)
    const onScroll = (e) => {
      const target = e.target === document ? document.documentElement : e.target;
      this._push({ type: 'scroll', target: getCssSelector(target), scrollX: target.scrollLeft || window.scrollX, scrollY: target.scrollTop || window.scrollY });
    };
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    this._listeners.push(['scroll', onScroll, { passive: true, capture: true }]);

    // Input (no values for privacy)
    const onInput = (e) => {
      const el = e.target;
      if (el.type === 'password') {
        this._push({ type: 'input', target: '[password]' });
      } else {
        this._push({ type: 'input', target: getCssSelector(el) });
      }
    };
    document.addEventListener('input', onInput, true);
    this._listeners.push(['input', onInput, true]);

    // Resize (debounced 200ms)
    const onResize = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._push({ type: 'resize', width: window.innerWidth, height: window.innerHeight });
      }, 200);
    };
    window.addEventListener('resize', onResize);
    this._listeners.push(['resize', onResize, false, window]);

    // Error
    const onError = (e) => {
      this._push({ type: 'error', message: e.message || String(e), filename: e.filename, lineno: e.lineno });
    };
    window.addEventListener('error', onError);
    this._listeners.push(['error', onError, false, window]);

    // Navigation — intercept pushState/replaceState
    const self = this;
    this._origPushState = history.pushState.bind(history);
    this._origReplaceState = history.replaceState.bind(history);

    history.pushState = function(...args) {
      const from = location.pathname;
      self._origPushState(...args);
      self._push({ type: 'navigation', from, to: location.pathname });
    };
    history.replaceState = function(...args) {
      const from = location.pathname;
      self._origReplaceState(...args);
      self._push({ type: 'navigation', from, to: location.pathname });
    };

    const onPopState = () => {
      this._push({ type: 'navigation', to: location.pathname });
    };
    window.addEventListener('popstate', onPopState);
    this._listeners.push(['popstate', onPopState, false, window]);

    // DOM Mutations
    this._observer = new MutationObserver((mutations) => {
      let added = 0;
      let removed = 0;
      for (const m of mutations) {
        added += m.addedNodes.length;
        removed += m.removedNodes.length;
      }
      if (added > 0 || removed > 0) {
        this._push({ type: 'mutation', added, removed });
      }
    });
    this._observer.observe(document.body, { childList: true, subtree: true });
  }

  detach() {
    if (!this._attached) return;

    for (const [event, handler, options, target] of this._listeners) {
      (target || document).removeEventListener(event, handler, options);
    }
    this._listeners = [];

    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }

    if (this._origPushState) {
      history.pushState = this._origPushState;
      history.replaceState = this._origReplaceState;
      this._origPushState = null;
      this._origReplaceState = null;
    }

    clearTimeout(this._resizeTimer);
    this._attached = false;
  }

  _push(event) {
    const now = Date.now();
    event.ts = now;
    this._events.push(event);

    // Trim by count
    if (this._events.length > this._maxEvents) {
      this._events.shift();
    }

    // Trim by age
    const cutoff = now - this._maxAge;
    while (this._events.length > 0 && this._events[0].ts < cutoff) {
      this._events.shift();
    }
  }

  getSessionReplay() {
    const now = Date.now();
    return this._events.map((e) => {
      const { ts, ...rest } = e;
      return { ...rest, t: ts - now };
    });
  }

  clear() { this._events = []; }
}
```

- [ ] **Step 2: Verify the file is valid ESM**

```bash
node -e "import('./src/react/sessionRecorder.js').then(m => console.log(Object.keys(m)))"
```

Expected: `['SessionRecorder']`

- [ ] **Step 3: Commit**

```bash
git add src/react/sessionRecorder.js
git commit -m "feat(react): add session recorder — 30s circular buffer of DOM events"
```

---

## Task 4: Create InspectOverlay.jsx

**Files:**
- Create: `src/react/InspectOverlay.jsx`

- [ ] **Step 1: Create InspectOverlay.jsx**

```jsx
import { useState, useEffect, useCallback } from 'react';
import { getComponentInfo } from './captureUtils.js';

export function InspectOverlay({ onSelect, onCancel }) {
  const [highlight, setHighlight] = useState(null);
  const [tooltip, setTooltip] = useState({ x: 0, y: 0 });

  const handleMouseMove = useCallback((e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.closest('[data-devtool-ignore]')) {
      setHighlight(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    const info = getComponentInfo(el);
    setHighlight({ rect, name: info.name });
    setTooltip({ x: e.clientX, y: e.clientY });
  }, []);

  const handleClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.closest('[data-devtool-ignore]')) return;
    const info = getComponentInfo(el);
    onSelect(info);
  }, [onSelect]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onCancel();
  }, [onCancel]);

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleKeyDown, true);
    document.body.style.cursor = 'crosshair';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove, true);
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.cursor = '';
    };
  }, [handleMouseMove, handleClick, handleKeyDown]);

  return (
    <div data-devtool-ignore style={{ position: 'fixed', inset: 0, zIndex: 99998, pointerEvents: 'none' }}>
      {highlight && (
        <div style={{
          position: 'fixed',
          top: highlight.rect.top, left: highlight.rect.left,
          width: highlight.rect.width, height: highlight.rect.height,
          border: '2px solid #ef4444',
          borderRadius: 4,
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          pointerEvents: 'none',
          transition: 'all 0.05s ease',
        }} />
      )}
      {highlight && (
        <div style={{
          position: 'fixed',
          top: tooltip.y + 16, left: tooltip.x + 12,
          background: '#1e1e2e', color: '#ef4444',
          padding: '4px 8px', borderRadius: 6,
          fontSize: 12, fontFamily: 'monospace',
          pointerEvents: 'none',
          border: '1px solid #ef4444',
          whiteSpace: 'nowrap',
        }}>
          &lt;{highlight.name}&gt;
        </div>
      )}
      <div style={{
        position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
        background: '#1e1e2e', color: '#e0e0e0',
        padding: '8px 16px', borderRadius: 8,
        fontSize: 13, fontWeight: 500,
        border: '1px solid #333',
        pointerEvents: 'auto',
      }}>
        Click any element to inspect · <span style={{ color: '#888' }}>Esc to cancel</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/react/InspectOverlay.jsx
git commit -m "feat(react): add InspectOverlay — element highlight and component detection"
```

---

## Task 5: Create RegionSelect.jsx

**Files:**
- Create: `src/react/RegionSelect.jsx`

- [ ] **Step 1: Create RegionSelect.jsx**

```jsx
import { useState, useCallback, useEffect, useRef } from 'react';
import { takeScreenshot } from './captureUtils.js';

export function RegionSelect({ onCapture, onCancel }) {
  const [dragging, setDragging] = useState(false);
  const [start, setStart] = useState(null);
  const [rect, setRect] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const overlayRef = useRef(null);

  const handleMouseDown = useCallback((e) => {
    if (e.target.closest('[data-devtool-ignore]')) return;
    setStart({ x: e.clientX, y: e.clientY });
    setDragging(true);
    setRect(null);
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (!dragging || !start) return;
    const x = Math.min(start.x, e.clientX);
    const y = Math.min(start.y, e.clientY);
    const width = Math.abs(e.clientX - start.x);
    const height = Math.abs(e.clientY - start.y);
    setRect({ x, y, width, height });
  }, [dragging, start]);

  const capture = useCallback(async (cropRect) => {
    setCapturing(true);
    const screenshot = await takeScreenshot(cropRect);
    setCapturing(false);
    if (screenshot) {
      onCapture(screenshot, cropRect);
    } else {
      onCapture(null, null);
    }
  }, [onCapture]);

  const handleMouseUp = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    if (rect && rect.width > 10 && rect.height > 10) {
      capture(rect);
    }
  }, [dragging, rect, capture]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      onCancel();
    } else if (e.key === 'Enter') {
      capture(null);
    }
  }, [onCancel, capture]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (capturing) {
    return (
      <div data-devtool-ignore style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)', color: 'white',
        fontSize: 16, fontFamily: 'system-ui',
      }}>
        Capturing...
      </div>
    );
  }

  return (
    <div
      data-devtool-ignore
      ref={overlayRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        cursor: 'crosshair',
        background: 'rgba(0,0,0,0.3)',
      }}
    >
      {rect && (
        <>
          {/* Clear window showing selected region */}
          <div style={{
            position: 'fixed',
            top: rect.y, left: rect.x,
            width: rect.width, height: rect.height,
            border: '2px solid #6366f1',
            borderRadius: 2,
            background: 'transparent',
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.3)',
          }} />
          {/* Dimension label */}
          <div style={{
            position: 'fixed',
            top: rect.y + rect.height + 8,
            left: rect.x,
            background: '#1e1e2e', color: '#e0e0e0',
            padding: '2px 8px', borderRadius: 4,
            fontSize: 11, fontFamily: 'monospace',
          }}>
            {Math.round(rect.width)} x {Math.round(rect.height)}
          </div>
        </>
      )}
      {/* Instruction banner */}
      <div style={{
        position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
        background: '#1e1e2e', color: '#e0e0e0',
        padding: '8px 16px', borderRadius: 8,
        fontSize: 13, fontWeight: 500,
        border: '1px solid #333',
      }}>
        Drag to select area · <span style={{ color: '#6366f1' }}>Enter</span> for full page · <span style={{ color: '#888' }}>Esc to go back</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/react/RegionSelect.jsx
git commit -m "feat(react): add RegionSelect — crop rectangle with screenshot capture"
```

---

## Task 6: Create AnnotationCanvas.jsx

**Files:**
- Create: `src/react/AnnotationCanvas.jsx`

- [ ] **Step 1: Create AnnotationCanvas.jsx**

```jsx
import { useState, useRef, useEffect, useCallback } from 'react';

const TOOLS = { ARROW: 'arrow', CIRCLE: 'circle', TEXT: 'text' };
const COLORS = ['#ef4444', '#facc15', '#3b82f6'];

export function AnnotationCanvas({ screenshot, onDone, onCancel }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const [tool, setTool] = useState(TOOLS.ARROW);
  const [color, setColor] = useState(COLORS[0]);
  const [annotations, setAnnotations] = useState([]);
  const [drawing, setDrawing] = useState(null);
  const [textInput, setTextInput] = useState(null);
  const [imgLoaded, setImgLoaded] = useState(false);

  // Load screenshot image
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.src = screenshot;
  }, [screenshot]);

  // Redraw canvas
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    const allAnnotations = drawing ? [...annotations, drawing] : annotations;
    for (const ann of allAnnotations) {
      ctx.strokeStyle = ann.color;
      ctx.fillStyle = ann.color;
      ctx.lineWidth = 3;

      if (ann.type === 'arrow') {
        const { x1, y1, x2, y2 } = ann;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        // Arrowhead
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const headLen = 15;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      } else if (ann.type === 'circle') {
        const { cx, cy, radius } = ann;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
        ctx.stroke();
      } else if (ann.type === 'text') {
        ctx.font = 'bold 16px system-ui';
        ctx.fillText(ann.text, ann.x, ann.y);
      }
    }
  }, [annotations, drawing]);

  useEffect(() => { if (imgLoaded) redraw(); }, [imgLoaded, redraw]);

  const getCanvasCoords = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  };

  const handleMouseDown = (e) => {
    const { x, y } = getCanvasCoords(e);
    if (tool === TOOLS.ARROW) {
      setDrawing({ type: 'arrow', color, x1: x, y1: y, x2: x, y2: y });
    } else if (tool === TOOLS.CIRCLE) {
      setDrawing({ type: 'circle', color, cx: x, cy: y, radius: 0 });
    } else if (tool === TOOLS.TEXT) {
      setTextInput({ x, y });
    }
  };

  const handleMouseMove = (e) => {
    if (!drawing) return;
    const { x, y } = getCanvasCoords(e);
    if (drawing.type === 'arrow') {
      setDrawing((d) => ({ ...d, x2: x, y2: y }));
    } else if (drawing.type === 'circle') {
      const radius = Math.sqrt((x - drawing.cx) ** 2 + (y - drawing.cy) ** 2);
      setDrawing((d) => ({ ...d, radius }));
    }
  };

  const handleMouseUp = () => {
    if (drawing) {
      setAnnotations((prev) => [...prev, drawing]);
      setDrawing(null);
    }
  };

  const handleTextSubmit = (text) => {
    if (text.trim() && textInput) {
      setAnnotations((prev) => [...prev, { type: 'text', color, x: textInput.x, y: textInput.y, text }]);
    }
    setTextInput(null);
  };

  const undo = () => setAnnotations((prev) => prev.slice(0, -1));

  const done = () => {
    redraw();
    setTimeout(() => {
      const canvas = canvasRef.current;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      onDone(dataUrl);
    }, 50);
  };

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') onCancel();
  }, [onCancel]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!imgLoaded) {
    return (
      <div data-devtool-ignore style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#1a1a2e', color: '#e0e0e0', fontSize: 16, fontFamily: 'system-ui',
      }}>
        Loading screenshot...
      </div>
    );
  }

  return (
    <div data-devtool-ignore style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: '#111', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', gap: 8, padding: '8px 16px',
        background: '#1e1e2e', borderRadius: 8, marginBottom: 12,
        border: '1px solid #333',
      }}>
        {[
          { key: TOOLS.ARROW, label: 'Arrow', icon: '↗' },
          { key: TOOLS.CIRCLE, label: 'Circle', icon: '○' },
          { key: TOOLS.TEXT, label: 'Text', icon: 'T' },
        ].map(({ key, label, icon }) => (
          <button key={key} onClick={() => setTool(key)} title={label} style={{
            width: 36, height: 36, borderRadius: 6,
            border: tool === key ? '2px solid #6366f1' : '1px solid #444',
            background: tool === key ? '#2d2d4e' : '#1e1e2e',
            color: '#e0e0e0', fontSize: 16, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {icon}
          </button>
        ))}
        <div style={{ width: 1, background: '#444', margin: '4px 4px' }} />
        {COLORS.map((c) => (
          <button key={c} onClick={() => setColor(c)} style={{
            width: 28, height: 28, borderRadius: '50%',
            border: color === c ? '3px solid white' : '2px solid #444',
            background: c, cursor: 'pointer',
            marginTop: 4,
          }} />
        ))}
        <div style={{ width: 1, background: '#444', margin: '4px 4px' }} />
        <button onClick={undo} disabled={annotations.length === 0} title="Undo" style={{
          width: 36, height: 36, borderRadius: 6,
          border: '1px solid #444', background: '#1e1e2e',
          color: annotations.length > 0 ? '#e0e0e0' : '#555',
          fontSize: 16, cursor: annotations.length > 0 ? 'pointer' : 'not-allowed',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          ↩
        </button>
        <div style={{ width: 1, background: '#444', margin: '4px 4px' }} />
        <button onClick={done} style={{
          padding: '0 16px', height: 36, borderRadius: 6,
          border: 'none', background: '#10b981', color: 'white',
          fontWeight: 600, fontSize: 13, cursor: 'pointer',
        }}>
          Done
        </button>
        <button onClick={onCancel} style={{
          padding: '0 12px', height: 36, borderRadius: 6,
          border: '1px solid #444', background: '#1e1e2e', color: '#888',
          fontSize: 13, cursor: 'pointer',
        }}>
          Cancel
        </button>
      </div>

      {/* Canvas */}
      <div style={{ position: 'relative', maxWidth: '90vw', maxHeight: '80vh', overflow: 'auto' }}>
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          style={{ cursor: tool === TOOLS.TEXT ? 'text' : 'crosshair', display: 'block', maxWidth: '100%', height: 'auto' }}
        />
        {textInput && (
          <input
            autoFocus
            type="text"
            placeholder="Type text..."
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleTextSubmit(e.target.value);
              if (e.key === 'Escape') setTextInput(null);
            }}
            onBlur={(e) => handleTextSubmit(e.target.value)}
            style={{
              position: 'absolute',
              top: (textInput.y / (imgRef.current?.height || 1)) * 100 + '%',
              left: (textInput.x / (imgRef.current?.width || 1)) * 100 + '%',
              background: 'rgba(0,0,0,0.7)', color, border: `1px solid ${color}`,
              borderRadius: 4, padding: '4px 8px', fontSize: 14,
              fontWeight: 'bold', fontFamily: 'system-ui',
              outline: 'none', minWidth: 120,
            }}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/react/AnnotationCanvas.jsx
git commit -m "feat(react): add AnnotationCanvas — arrows, circles, text on screenshots"
```

---

## Task 7: Create BugReportPanel.jsx

**Files:**
- Create: `src/react/BugReportPanel.jsx`

- [ ] **Step 1: Create BugReportPanel.jsx**

```jsx
import { useState } from 'react';

export function BugReportPanel({
  componentInfo, consoleEntries, networkErrors, perfMetrics,
  screenshot, onSubmit, onCancel, submitting,
}) {
  const [description, setDescription] = useState('');
  const [screenshotExpanded, setScreenshotExpanded] = useState(false);

  const handleSubmit = () => {
    if (!description.trim()) return;
    onSubmit(description.trim());
  };

  const errorCount = (consoleEntries || []).filter((e) => e.level === 'error').length;
  const warnCount = (consoleEntries || []).filter((e) => e.level === 'warn').length;

  const perfColor = (metric, good, bad) => {
    if (metric == null) return '#888';
    return metric <= good ? '#10b981' : metric <= bad ? '#facc15' : '#ef4444';
  };

  return (
    <div data-devtool-ignore style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 400,
      background: '#1a1a2e', color: '#e0e0e0', zIndex: 99999,
      boxShadow: '-4px 0 24px rgba(0,0,0,0.4)',
      display: 'flex', flexDirection: 'column',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      animation: 'devpanel-slide-in 0.2s ease',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px', borderBottom: '1px solid #333',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>🐛</span>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Bug Report</span>
        </div>
        <button onClick={onCancel} style={{
          background: 'none', border: 'none', color: '#888', cursor: 'pointer',
          padding: 4, fontSize: 20, lineHeight: 1,
        }}>×</button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Component info */}
        {componentInfo && (
          <div style={{ background: '#16213e', borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 600, marginBottom: 4 }}>
              Selected: &lt;{componentInfo.name}&gt;
            </div>
            {componentInfo.file && (
              <div style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>
                {componentInfo.file}
              </div>
            )}
            {componentInfo.props && Object.keys(componentInfo.props).length > 0 && (
              <div style={{ fontSize: 11, color: '#888', marginTop: 4, fontFamily: 'monospace' }}>
                Props: {JSON.stringify(componentInfo.props)}
              </div>
            )}
          </div>
        )}

        {/* Console errors */}
        {(errorCount > 0 || warnCount > 0) && (
          <div style={{ background: '#16213e', borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: '#f59e0b' }}>
              ⚠ Console ({errorCount} errors, {warnCount} warnings)
            </div>
            {(consoleEntries || []).slice(-5).map((entry, i) => (
              <div key={i} style={{
                fontSize: 10, fontFamily: 'monospace', marginTop: 2,
                color: entry.level === 'error' ? '#ef4444' : entry.level === 'warn' ? '#f59e0b' : '#888',
              }}>
                [{entry.level}] {entry.message.slice(0, 120)}
              </div>
            ))}
          </div>
        )}

        {/* Network errors */}
        {(networkErrors || []).length > 0 && (
          <div style={{ background: '#16213e', borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: '#ef4444' }}>
              📡 Failed requests ({networkErrors.length})
            </div>
            {(networkErrors || []).slice(-5).map((err, i) => (
              <div key={i} style={{ fontSize: 10, fontFamily: 'monospace', color: '#ef4444', marginTop: 2 }}>
                {err.method} {err.url} → {err.status}
              </div>
            ))}
          </div>
        )}

        {/* Performance metrics */}
        {perfMetrics && (perfMetrics.lcp != null || perfMetrics.fcp != null) && (
          <div style={{ background: '#16213e', borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: '#6366f1' }}>
              ⚡ Performance
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 11, fontFamily: 'monospace' }}>
              {perfMetrics.fcp != null && (
                <span>FCP: <span style={{ color: perfColor(perfMetrics.fcp, 1800, 3000) }}>{perfMetrics.fcp}ms</span></span>
              )}
              {perfMetrics.lcp != null && (
                <span>LCP: <span style={{ color: perfColor(perfMetrics.lcp, 2500, 4000) }}>{perfMetrics.lcp}ms</span></span>
              )}
              {perfMetrics.cls != null && (
                <span>CLS: <span style={{ color: perfColor(perfMetrics.cls, 0.1, 0.25) }}>{perfMetrics.cls}</span></span>
              )}
            </div>
          </div>
        )}

        {/* Screenshot preview */}
        {screenshot && (
          <div style={{ background: '#16213e', borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: '#10b981' }}>
              📸 Screenshot
            </div>
            <img
              src={screenshot}
              onClick={() => setScreenshotExpanded(!screenshotExpanded)}
              style={{
                width: '100%', borderRadius: 4, cursor: 'pointer',
                maxHeight: screenshotExpanded ? 'none' : 150,
                objectFit: screenshotExpanded ? 'contain' : 'cover',
              }}
              alt="Bug screenshot"
            />
          </div>
        )}

        {/* Description */}
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe the bug..."
          style={{
            width: '100%', minHeight: 80, background: '#16213e',
            border: '1px solid #333', borderRadius: 8, padding: 12,
            color: '#e0e0e0', fontSize: 13, resize: 'vertical',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Footer */}
      <div style={{ padding: '16px 20px', borderTop: '1px solid #333', display: 'flex', gap: 8 }}>
        <button
          onClick={handleSubmit}
          disabled={!description.trim() || submitting}
          style={{
            flex: 1, padding: '10px 16px', borderRadius: 8,
            background: description.trim() && !submitting ? '#ef4444' : '#333',
            color: 'white', border: 'none', fontWeight: 600,
            fontSize: 13, cursor: description.trim() && !submitting ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'Sending...' : 'Submit Bug'}
        </button>
        <button onClick={onCancel} style={{
          padding: '10px 16px', borderRadius: 8,
          background: '#333', color: '#888', border: 'none',
          fontSize: 13, cursor: 'pointer',
        }}>
          Cancel
        </button>
      </div>

      <style>{`
        @keyframes devpanel-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
      `}</style>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/react/BugReportPanel.jsx
git commit -m "feat(react): add BugReportPanel — dark slide-in with auto-captured context"
```

---

## Task 8: Create FeaturePanel.jsx

**Files:**
- Create: `src/react/FeaturePanel.jsx`

- [ ] **Step 1: Create FeaturePanel.jsx**

```jsx
import { useState } from 'react';

export function FeaturePanel({ onSubmit, onCancel, submitting }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const handleSubmit = () => {
    if (!title.trim() || !description.trim()) return;
    onSubmit(title.trim(), description.trim());
  };

  const canSubmit = title.trim() && description.trim() && !submitting;

  return (
    <div data-devtool-ignore style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 400,
      background: '#1a1a2e', color: '#e0e0e0', zIndex: 99999,
      boxShadow: '-4px 0 24px rgba(0,0,0,0.4)',
      display: 'flex', flexDirection: 'column',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      animation: 'devpanel-slide-in 0.2s ease',
    }}>
      {/* Header */}
      <div style={{
        padding: '16px 20px', borderBottom: '1px solid #333',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 18 }}>💡</span>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Feature Request</span>
        </div>
        <button onClick={onCancel} style={{
          background: 'none', border: 'none', color: '#888', cursor: 'pointer',
          padding: 4, fontSize: 20, lineHeight: 1,
        }}>×</button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500 }}>
            Title *
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Feature you want to request"
            style={{
              width: '100%', padding: 10, background: '#16213e',
              border: '1px solid #333', borderRadius: 6,
              color: '#e0e0e0', fontSize: 13,
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: 8, fontSize: 13, fontWeight: 500 }}>
            Description *
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the feature and why it would be useful"
            rows={8}
            style={{
              width: '100%', padding: 10, background: '#16213e',
              border: '1px solid #333', borderRadius: 6,
              color: '#e0e0e0', fontSize: 13, resize: 'vertical',
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '16px 20px', borderTop: '1px solid #333', display: 'flex', gap: 8 }}>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          style={{
            flex: 1, padding: '10px 16px', borderRadius: 8,
            background: canSubmit ? '#6366f1' : '#333',
            color: 'white', border: 'none', fontWeight: 600,
            fontSize: 13, cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'Sending...' : 'Submit Feature'}
        </button>
        <button onClick={onCancel} style={{
          padding: '10px 16px', borderRadius: 8,
          background: '#333', color: '#888', border: 'none',
          fontSize: 13, cursor: 'pointer',
        }}>
          Cancel
        </button>
      </div>

      <style>{`
        @keyframes devpanel-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
      `}</style>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/react/FeaturePanel.jsx
git commit -m "feat(react): add FeaturePanel — dark slide-in for feature requests"
```

---

## Task 9: Rewrite DevPanel.jsx (orchestrator)

**Files:**
- Rewrite: `src/react/DevPanel.jsx`

- [ ] **Step 1: Rewrite DevPanel.jsx with full state machine**

```jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { ConsoleBuffer, NetworkInterceptor, PerfMetrics, takeScreenshot } from './captureUtils.js';
import { SessionRecorder } from './sessionRecorder.js';
import { InspectOverlay } from './InspectOverlay.jsx';
import { RegionSelect } from './RegionSelect.jsx';
import { AnnotationCanvas } from './AnnotationCanvas.jsx';
import { BugReportPanel } from './BugReportPanel.jsx';
import { FeaturePanel } from './FeaturePanel.jsx';

// State machine: idle → menu → inspecting → region-select → annotating → bug-report → submitting → idle
//                idle → menu → feature-panel → submitting → idle

export function DevPanel({ apiUrl = 'http://localhost:3030', apiKey, position = 'bottom-right' }) {
  if (!apiKey) {
    console.warn('DevPanel: No API key provided. Component will not render.');
    return null;
  }

  const [mode, setMode] = useState('idle');
  const [componentInfo, setComponentInfo] = useState(null);
  const [screenshot, setScreenshot] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);

  const consoleBuffer = useRef(null);
  const networkInterceptor = useRef(null);
  const perfMetrics = useRef(null);
  const sessionRecorder = useRef(null);

  // Attach capture utilities on mount
  useEffect(() => {
    consoleBuffer.current = new ConsoleBuffer(50);
    consoleBuffer.current.attach();
    networkInterceptor.current = new NetworkInterceptor(50);
    networkInterceptor.current.attach();
    perfMetrics.current = new PerfMetrics();
    perfMetrics.current.attach();
    sessionRecorder.current = new SessionRecorder();
    sessionRecorder.current.attach();

    return () => {
      consoleBuffer.current?.detach();
      networkInterceptor.current?.detach();
      perfMetrics.current?.detach();
      sessionRecorder.current?.detach();
    };
  }, []);

  // Auto-clear toast after 3s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Escape closes menu
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && mode === 'menu') setMode('idle');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);

  const reset = useCallback(() => {
    setMode('idle');
    setComponentInfo(null);
    setScreenshot(null);
    setSubmitting(false);
  }, []);

  const handleInspectSelect = useCallback((info) => {
    setComponentInfo(info);
    setMode('region-select');
  }, []);

  const handleRegionCapture = useCallback((screenshotBase64) => {
    if (screenshotBase64) {
      setScreenshot(screenshotBase64);
      setMode('annotating');
    } else {
      // Screenshot failed, skip to bug report without screenshot
      setMode('bug-report');
    }
  }, []);

  const handleAnnotationDone = useCallback((annotated) => {
    setScreenshot(annotated);
    setMode('bug-report');
  }, []);

  const submitBug = useCallback(async (description) => {
    setSubmitting(true);
    setMode('submitting');
    try {
      const title = componentInfo
        ? `${componentInfo.name}: ${description.slice(0, 60)}`
        : description.slice(0, 80);

      const payload = {
        type: 'bug',
        title,
        description,
        created_by: 'user',
        context: {
          url: window.location.href,
          userAgent: navigator.userAgent,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          timestamp: Date.now(),
          component: componentInfo || undefined,
          console: consoleBuffer.current?.getEntries() || [],
          network: networkInterceptor.current?.getErrors() || [],
          performance: perfMetrics.current?.getMetrics() || {},
          sessionReplay: sessionRecorder.current?.getSessionReplay() || [],
        },
      };

      if (screenshot) {
        payload.screenshot = screenshot;
      }

      const response = await fetch(`${apiUrl}/api/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error('Failed to submit');
      const result = await response.json();
      setToast({ kind: 'success', message: `Bug #${result.id} reported` });
    } catch (err) {
      setToast({ kind: 'error', message: err.message });
    }
    reset();
  }, [apiUrl, apiKey, componentInfo, screenshot, reset]);

  const submitFeature = useCallback(async (title, description) => {
    setSubmitting(true);
    setMode('submitting');
    try {
      const payload = {
        type: 'feature',
        title,
        description,
        created_by: 'user',
        context: {
          url: window.location.href,
          userAgent: navigator.userAgent,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          timestamp: Date.now(),
        },
      };

      const response = await fetch(`${apiUrl}/api/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error('Failed to submit');
      const result = await response.json();
      setToast({ kind: 'success', message: `Feature #${result.id} submitted` });
    } catch (err) {
      setToast({ kind: 'error', message: err.message });
    }
    reset();
  }, [apiUrl, apiKey, reset]);

  const isRight = position === 'bottom-right';
  const fabStyle = {
    position: 'fixed', bottom: 24, [isRight ? 'right' : 'left']: 24,
    zIndex: 99999, width: 48, height: 48, borderRadius: '50%',
    background: mode === 'idle' ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : '#333',
    color: 'white', border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', boxShadow: '0 4px 16px rgba(99,102,241,0.4)',
    transition: 'all 0.2s ease', fontSize: 20,
  };

  return (
    <>
      {mode === 'inspecting' && (
        <InspectOverlay onSelect={handleInspectSelect} onCancel={() => setMode('menu')} />
      )}

      {mode === 'region-select' && (
        <RegionSelect onCapture={handleRegionCapture} onCancel={() => setMode('inspecting')} />
      )}

      {mode === 'annotating' && screenshot && (
        <AnnotationCanvas
          screenshot={screenshot}
          onDone={handleAnnotationDone}
          onCancel={() => setMode('region-select')}
        />
      )}

      {(mode === 'bug-report' || (mode === 'submitting' && submitting)) && (
        <BugReportPanel
          componentInfo={componentInfo}
          consoleEntries={consoleBuffer.current?.getEntries()}
          networkErrors={networkInterceptor.current?.getErrors()}
          perfMetrics={perfMetrics.current?.getMetrics()}
          screenshot={screenshot}
          onSubmit={submitBug}
          onCancel={reset}
          submitting={submitting}
        />
      )}

      {mode === 'feature-panel' && (
        <FeaturePanel
          onSubmit={submitFeature}
          onCancel={reset}
          submitting={submitting}
        />
      )}

      {mode === 'menu' && (
        <div data-devtool-ignore style={{
          position: 'fixed', bottom: 80, [isRight ? 'right' : 'left']: 24,
          zIndex: 99999, display: 'flex', flexDirection: 'column', gap: 8,
          animation: 'devpanel-fade-in 0.15s ease',
        }}>
          <button onClick={() => setMode('inspecting')} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 16px', borderRadius: 10,
            background: '#ef4444', color: 'white', border: 'none',
            fontWeight: 600, fontSize: 13, cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(239,68,68,0.35)', minWidth: 180,
          }}>
            🐛 Report Bug
          </button>
          <button onClick={() => setMode('feature-panel')} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 16px', borderRadius: 10,
            background: '#6366f1', color: 'white', border: 'none',
            fontWeight: 600, fontSize: 13, cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(99,102,241,0.35)', minWidth: 180,
          }}>
            💡 Request Feature
          </button>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div data-devtool-ignore style={{
          position: 'fixed', bottom: 80, [isRight ? 'right' : 'left']: 24,
          zIndex: 100000, display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 16px', borderRadius: 10,
          background: toast.kind === 'success' ? '#10b981' : '#ef4444',
          color: 'white', fontWeight: 600, fontSize: 13,
          boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
          animation: 'devpanel-fade-in 0.2s ease',
        }}>
          {toast.kind === 'success' ? '✓' : '✗'} {toast.message}
        </div>
      )}

      {/* FAB */}
      {(mode === 'idle' || mode === 'menu') && (
        <button
          data-devtool-ignore
          onClick={() => setMode(mode === 'idle' ? 'menu' : 'idle')}
          style={fabStyle}
          title="DevPanel"
        >
          🐛
        </button>
      )}

      <style>{`
        @keyframes devpanel-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes devpanel-slide-in { from { transform: translateX(100%); } to { transform: translateX(0); } }
      `}</style>
    </>
  );
}
```

- [ ] **Step 2: Verify imports resolve**

```bash
node -e "import('./src/react/index.js').then(m => console.log('DevPanel exported:', typeof m.DevPanel))"
```

Expected: `DevPanel exported: function`

- [ ] **Step 3: Commit**

```bash
git add src/react/DevPanel.jsx
git commit -m "feat(react): rewrite DevPanel orchestrator with full state machine

Replaces the basic file-picker widget with inspect overlay, region
screenshot, annotation canvas, auto-captured context (console, network,
perf, session replay), and dark-theme slide-in panels."
```

---

## Task 10: Manual integration test

- [ ] **Step 1: Rebuild and redeploy Docker image**

```bash
cd /Users/franckbirba/DEV/dev-panel
docker build -t ghcr.io/franckbirba/dev-panel:latest .
```

- [ ] **Step 2: Test in the EDMS app**

Open `http://localhost:3001/admin`, click the FAB, go through the full bug report flow:
1. Click "Report Bug"
2. Hover elements — verify highlight and component name tooltip
3. Click an element — verify transition to region select
4. Draw a rectangle — verify screenshot capture
5. Annotate (draw arrow, circle, add text) — verify toolbar works
6. Click Done — verify BugReportPanel shows with context sections
7. Write description, submit — verify ticket created on devpanl.dev

- [ ] **Step 3: Test feature request flow**

1. Click FAB → "Request Feature"
2. Fill title + description
3. Submit — verify ticket created

- [ ] **Step 4: Commit all remaining changes and push**

```bash
git add -A
git commit -m "feat(react): DevPanel widget v3 — complete rewrite with inspect, annotate, session replay"
git push
```
