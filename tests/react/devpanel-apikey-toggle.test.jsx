// @vitest-environment jsdom
//
// Regression test for GlitchTip issue #41: DevPanel widget runtime error.
//
// Root cause: DevPanel returned `null` early when `apiKey` was missing, BEFORE
// calling any hook. When the host app later supplied apiKey (e.g. after SSO
// hydration or a project switch), the next render called all 12+ hooks, and
// React detects "Rendered more hooks than during the previous render" — a
// rules-of-hooks violation that crashes the widget on the consumer site.
//
// We use react-dom/client + flushSync directly instead of @testing-library/react
// because RTL 16.x calls `React.act`, which is not exported by the React 19.2
// production build available in this repo (see memory 9dcee181).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createElement } from 'react';
import { DevPanel } from '../../src/react/DevPanel.jsx';
import devPanelSource from '../../src/react/DevPanel.jsx?raw';

describe('DevPanel apiKey toggle (GlitchTip #41 regression)', () => {
  let container;
  let root;
  let originalFetch;
  let consoleErrorSpy;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    global.fetch = originalFetch;
    consoleErrorSpy.mockRestore();
  });

  it('renders nothing when apiKey is missing', () => {
    flushSync(() => root.render(createElement(DevPanel, { apiUrl: 'http://test' })));
    expect(container.querySelector('[aria-label="DevPanel"]')).toBeNull();
  });

  it('renders the FAB when apiKey is provided from the start', () => {
    flushSync(() => root.render(createElement(DevPanel, { apiUrl: 'http://test', apiKey: 'dp_test' })));
    expect(container.querySelector('[aria-label="DevPanel"]')).not.toBeNull();
  });

  it('does not crash when apiKey is provided AFTER an initial render without it', () => {
    // First render: no apiKey. Pre-fix this skipped every hook.
    flushSync(() => root.render(createElement(DevPanel, { apiUrl: 'http://test' })));
    expect(container.querySelector('[aria-label="DevPanel"]')).toBeNull();

    // Second render: apiKey now set. Pre-fix this called 12+ hooks where the
    // previous render had called 0, triggering the React invariant
    // "Rendered more hooks than during the previous render."
    flushSync(() =>
      root.render(createElement(DevPanel, { apiUrl: 'http://test', apiKey: 'dp_test' })),
    );

    const allErrors = consoleErrorSpy.mock.calls.map((call) => call.map(String).join(' '));
    const hookErrors = allErrors.filter(
      (msg) => /Rendered (more|fewer) hooks/i.test(msg) || /Should have a queue/i.test(msg),
    );
    expect(hookErrors).toEqual([]);
    // Catch any other React invariants that surface from a hooks-order mismatch
    // (e.g. "Cannot read properties of null (reading 'useState')").
    const reactInvariants = allErrors.filter((msg) =>
      /reading 'useState'|reading 'useEffect'|reading 'useRef'|reading 'useMemo'|reading 'useCallback'/i.test(
        msg,
      ),
    );
    expect(reactInvariants).toEqual([]);

    expect(container.querySelector('[aria-label="DevPanel"]')).not.toBeNull();
  });

  it('declares all hooks before any conditional return (no early-return-before-hooks)', async () => {
    // Hooks-order rule: a component must call the same hooks in the same order
    // on every render. Pre-fix, DevPanel returned null BEFORE any hook when
    // apiKey was missing, so render 1 ran 0 hooks and render 2 ran 12+ — a
    // rules-of-hooks violation. Static source check: no `return` may appear
    // between the function signature and the first `useState/useEffect/useRef`
    // call.
    const src = devPanelSource;

    const fnStart = src.indexOf('export function DevPanel');
    expect(fnStart).toBeGreaterThan(-1);
    const firstHook = src.search(/\b(useState|useEffect|useRef|useMemo|useCallback)\s*\(/);
    expect(firstHook).toBeGreaterThan(fnStart);

    const preludeChunk = src.slice(fnStart, firstHook);
    // Strip line comments so a comment containing "return" doesn't trip the
    // check, then look for any `return` statement (with or without args).
    const stripped = preludeChunk.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(/\breturn\b/.test(stripped)).toBe(false);
  });

  it('does not crash when apiKey is removed AFTER an initial render with it', () => {
    flushSync(() => root.render(createElement(DevPanel, { apiUrl: 'http://test', apiKey: 'dp_test' })));
    expect(container.querySelector('[aria-label="DevPanel"]')).not.toBeNull();

    flushSync(() => root.render(createElement(DevPanel, { apiUrl: 'http://test' })));

    const hookErrors = consoleErrorSpy.mock.calls
      .map((call) => call.map(String).join(' '))
      .filter((msg) => /Rendered (more|fewer) hooks/i.test(msg) || /Should have a queue/i.test(msg));
    expect(hookErrors).toEqual([]);

    expect(container.querySelector('[aria-label="DevPanel"]')).toBeNull();
  });
});
