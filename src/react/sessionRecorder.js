/**
 * SessionRecorder — 30-second circular buffer of DOM events
 * Pure ESM, no external dependencies.
 */

function getCssSelector(el) {
  if (!el || el === document.body || !(el instanceof Element)) return 'body';
  if (el.id) return `#${el.id}`;
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).slice(0, 2).join('.');
  return classes ? `${tag}.${classes}` : tag;
}

export class SessionRecorder {
  constructor({ maxEvents = 500, maxAge = 30000 } = {}) {
    this.maxEvents = maxEvents;
    this.maxAge = maxAge;
    this._buffer = [];
    this._attached = false;
    this._listeners = []; // [event, handler, options, target]
    this._originalPushState = null;
    this._originalReplaceState = null;
    this._mutationObserver = null;
    this._resizeTimer = null;
    this._currentUrl = typeof window !== 'undefined' ? window.location.href : '';
  }

  _push(event) {
    const now = Date.now();
    this._buffer.push({ ...event, ts: now });
    // Trim by maxAge
    const cutoff = now - this.maxAge;
    while (this._buffer.length > 0 && this._buffer[0].ts < cutoff) {
      this._buffer.shift();
    }
    // Trim by maxEvents
    while (this._buffer.length > this.maxEvents) {
      this._buffer.shift();
    }
  }

  _addListener(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    this._listeners.push([event, handler, options, target]);
  }

  attach() {
    if (this._attached) return;
    this._attached = true;

    // click
    const clickHandler = (e) => {
      this._push({
        type: 'click',
        target: getCssSelector(e.target),
        x: e.clientX,
        y: e.clientY,
      });
    };
    this._addListener(window, 'click', clickHandler, true);

    // scroll
    const scrollHandler = (e) => {
      const target = e.target === document ? document.documentElement : e.target;
      this._push({
        type: 'scroll',
        target: getCssSelector(target instanceof Element ? target : document.body),
        scrollX: target.scrollLeft ?? window.scrollX,
        scrollY: target.scrollTop ?? window.scrollY,
      });
    };
    this._addListener(window, 'scroll', scrollHandler, { passive: true, capture: true });

    // input (no value for privacy)
    const inputHandler = (e) => {
      const el = e.target;
      const isPassword =
        el instanceof HTMLInputElement && el.type === 'password';
      this._push({
        type: 'input',
        target: isPassword ? '[password]' : getCssSelector(el),
      });
    };
    this._addListener(window, 'input', inputHandler, true);

    // navigation — popstate
    const popstateHandler = () => {
      const from = this._currentUrl;
      const to = window.location.href;
      this._currentUrl = to;
      this._push({ type: 'navigation', from, to });
    };
    this._addListener(window, 'popstate', popstateHandler, false);

    // navigation — intercept pushState / replaceState
    const self = this;
    this._originalPushState = history.pushState.bind(history);
    this._originalReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args) {
      const from = self._currentUrl;
      self._originalPushState(...args);
      const to = window.location.href;
      self._currentUrl = to;
      self._push({ type: 'navigation', from, to });
    };

    history.replaceState = function (...args) {
      const from = self._currentUrl;
      self._originalReplaceState(...args);
      const to = window.location.href;
      self._currentUrl = to;
      self._push({ type: 'navigation', from, to });
    };

    // mutation
    this._mutationObserver = new MutationObserver((mutations) => {
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
    this._mutationObserver.observe(document.body, { childList: true, subtree: true });

    // resize — debounced 200ms
    const resizeHandler = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._push({
          type: 'resize',
          width: window.innerWidth,
          height: window.innerHeight,
        });
      }, 200);
    };
    this._addListener(window, 'resize', resizeHandler, false);

    // error
    const errorHandler = (e) => {
      this._push({
        type: 'error',
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
      });
    };
    this._addListener(window, 'error', errorHandler, false);
  }

  detach() {
    if (!this._attached) return;
    this._attached = false;

    // Remove all stored listeners
    for (const [event, handler, options, target] of this._listeners) {
      target.removeEventListener(event, handler, options);
    }
    this._listeners = [];

    // Restore pushState / replaceState
    if (this._originalPushState) {
      history.pushState = this._originalPushState;
      this._originalPushState = null;
    }
    if (this._originalReplaceState) {
      history.replaceState = this._originalReplaceState;
      this._originalReplaceState = null;
    }

    // Disconnect MutationObserver
    if (this._mutationObserver) {
      this._mutationObserver.disconnect();
      this._mutationObserver = null;
    }

    // Clear any pending resize timer
    clearTimeout(this._resizeTimer);
    this._resizeTimer = null;
  }

  getSessionReplay() {
    const now = Date.now();
    return this._buffer.map((event) => ({
      ...event,
      ts: event.ts - now, // negative ms from now
    }));
  }

  clear() {
    this._buffer = [];
  }
}

export { getCssSelector };
