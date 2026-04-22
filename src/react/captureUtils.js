/**
 * captureUtils.js
 * Capture utilities for dev-panel: console buffering, network interception,
 * component introspection, screenshot, and performance metrics.
 */

// ---------------------------------------------------------------------------
// 1. ConsoleBuffer — ring buffer intercepting console.log/warn/error
// ---------------------------------------------------------------------------

export class ConsoleBuffer {
  #maxSize = 50;
  #entries = [];
  #originals = {};

  attach() {
    for (const level of ['log', 'warn', 'error']) {
      this.#originals[level] = console[level].bind(console);
      console[level] = (...args) => {
        this.#originals[level](...args);
        const message = args.map(a => {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
          catch { return String(a); }
        }).join(' ');
        this.#entries.push({ level, message, timestamp: Date.now() });
        if (this.#entries.length > this.#maxSize) this.#entries.shift();
      };
    }
  }

  detach() {
    for (const level of ['log', 'warn', 'error']) {
      if (this.#originals[level]) {
        console[level] = this.#originals[level];
        delete this.#originals[level];
      }
    }
  }

  getEntries() {
    return [...this.#entries];
  }

  clear() {
    this.#entries = [];
  }
}

// ---------------------------------------------------------------------------
// 2. NetworkInterceptor — ring buffer intercepting fetch, records >= 400
// ---------------------------------------------------------------------------

export class NetworkInterceptor {
  #maxSize = 50;
  #errors = [];
  #originalFetch = null;

  attach() {
    this.#originalFetch = globalThis.fetch;
    const self = this;

    const patchedFetch = async function (...args) {
      const [input, init] = args;
      const method = (init && init.method ? init.method : 'GET').toUpperCase();
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      const response = await self.#originalFetch.apply(this, args);

      if (response.status >= 400) {
        self.#errors.push({
          method,
          url,
          status: response.status,
          statusText: response.statusText,
          timestamp: Date.now(),
        });
        if (self.#errors.length > self.#maxSize) self.#errors.shift();
      }

      return response;
    };

    try {
      Object.defineProperty(globalThis, 'fetch', {
        get: () => patchedFetch,
        set: (v) => { this.#originalFetch = v; },
        configurable: true,
      });
    } catch {
      // Fallback if defineProperty not supported
      globalThis.fetch = patchedFetch;
    }
  }

  detach() {
    if (this.#originalFetch) {
      try {
        Object.defineProperty(globalThis, 'fetch', {
          value: this.#originalFetch,
          writable: true,
          configurable: true,
        });
      } catch {
        globalThis.fetch = this.#originalFetch;
      }
      this.#originalFetch = null;
    }
  }

  getErrors() {
    return [...this.#errors];
  }

  clear() {
    this.#errors = [];
  }
}

// ---------------------------------------------------------------------------
// 3. getComponentInfo(element) — React fiber introspection
// ---------------------------------------------------------------------------

export function getComponentInfo(element) {
  if (!element || typeof element !== 'object') {
    return { name: 'unknown', file: null, props: {} };
  }

  // Find the React fiber key (e.g. __reactFiber$abc123)
  const fiberKey = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
  if (!fiberKey) {
    return { name: element.tagName ? element.tagName.toLowerCase() : 'unknown', file: null, props: {} };
  }

  let fiber = element[fiberKey];

  // Walk up the fiber tree to find the nearest function or class component
  while (fiber) {
    const type = fiber.type;
    if (type) {
      const isFunction = typeof type === 'function';
      const isClass = isFunction && type.prototype && type.prototype.isReactComponent;
      if (isFunction) {
        const name = type.displayName || type.name || 'Anonymous';

        // Extract file from stack trace if available (React DevTools __source)
        let file = null;
        if (fiber._debugSource) {
          file = fiber._debugSource.fileName || null;
        }

        // Shallow clone props, omit children and functions, objects as '[Object]'
        const rawProps = fiber.memoizedProps || {};
        const props = {};
        for (const [k, v] of Object.entries(rawProps)) {
          if (k === 'children') continue;
          if (typeof v === 'function') continue;
          if (v !== null && typeof v === 'object') {
            props[k] = '[Object]';
          } else {
            props[k] = v;
          }
        }

        return { name, file, props };
      }
    }
    fiber = fiber.return;
  }

  // Fallback
  return {
    name: element.tagName ? element.tagName.toLowerCase() : 'unknown',
    file: null,
    props: {},
  };
}

// ---------------------------------------------------------------------------
// 4. captureViaDisplayMedia() — native browser screenshot via getDisplayMedia.
//    Triggers a permission prompt; user picks tab/window/screen. Pixel-perfect
//    rendering (no CSS guessing like html2canvas). Returns a data URL or null
//    on cancel/error.
// ---------------------------------------------------------------------------

export async function captureViaDisplayMedia() {
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      audio: false,
      preferCurrentTab: true  // Chrome hint to default to the current tab.
    });
    const track = stream.getVideoTracks()[0];
    // Grab a single frame. ImageCapture is the modern path; grab via video
    // element as a fallback for browsers without it (Firefox).
    let bitmap;
    if (typeof ImageCapture !== 'undefined') {
      const capture = new ImageCapture(track);
      bitmap = await capture.grabFrame();
    } else {
      const video = document.createElement('video');
      video.srcObject = stream;
      await video.play();
      bitmap = await createImageBitmap(video);
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (err) {
    // User cancelled the picker, or permission denied. Both are fine.
    if (err?.name !== 'NotAllowedError') {
      console.warn('[captureUtils] captureViaDisplayMedia failed:', err);
    }
    return null;
  } finally {
    if (stream) stream.getTracks().forEach(t => t.stop());
  }
}

// ---------------------------------------------------------------------------
// 5. takeScreenshot(rect?) — html2canvas-based screenshot (legacy fallback)
// ---------------------------------------------------------------------------

export async function takeScreenshot(rect) {
  try {
    const html2canvas = (await import('html2canvas')).default;

    // html2canvas hangs silently on pages with cross-origin images that
    // lack CORS headers (Epitech Africa site hits this). Race against a
    // 10s timeout so the UI can't get stuck on "capturing…" forever.
    const canvas = await Promise.race([
      html2canvas(document.body, {
        useCORS: true,
        scale: 1,
        logging: false,
        width: Math.min(window.innerWidth, 1920),
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('screenshot timeout after 10s')), 10_000)
      )
    ]);

    let finalCanvas = canvas;

    if (rect && typeof rect === 'object') {
      const { x = 0, y = 0, width, height } = rect;
      if (width > 0 && height > 0) {
        const cropped = document.createElement('canvas');
        cropped.width = width;
        cropped.height = height;
        const ctx = cropped.getContext('2d');
        ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
        finalCanvas = cropped;
      }
    }

    return finalCanvas.toDataURL('image/jpeg', 0.7);
  } catch (err) {
    console.warn('[captureUtils] takeScreenshot failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 5. PerfMetrics — PerformanceObserver for LCP, CLS, FCP
// ---------------------------------------------------------------------------

export class PerfMetrics {
  #metrics = { lcp: null, cls: 0, fcp: null };
  #observers = [];

  attach() {
    // LCP
    try {
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) {
          this.#metrics.lcp = entries[entries.length - 1].startTime;
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
      this.#observers.push(lcpObserver);
    } catch { /* not supported */ }

    // CLS
    try {
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            this.#metrics.cls = parseFloat((this.#metrics.cls + entry.value).toFixed(3));
          }
        }
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });
      this.#observers.push(clsObserver);
    } catch { /* not supported */ }

    // FCP
    try {
      const fcpObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') {
            this.#metrics.fcp = entry.startTime;
          }
        }
      });
      fcpObserver.observe({ type: 'paint', buffered: true });
      this.#observers.push(fcpObserver);
    } catch { /* not supported */ }
  }

  detach() {
    for (const observer of this.#observers) {
      try { observer.disconnect(); } catch { /* ignore */ }
    }
    this.#observers = [];
  }

  getMetrics() {
    return { ...this.#metrics };
  }
}
