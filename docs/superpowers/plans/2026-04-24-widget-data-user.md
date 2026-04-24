# Widget data-user Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standalone `/widget.js` bundle reads a JSON-encoded `data-user` attribute off its own `<script>` tag and forwards it to the existing DevPanel `user` prop. Vanilla-HTML hosts (Zeno, future) can now tag captures with reporter identity — same flow as React hosts that pass `user={...}` directly.

**Architecture:** One function modified in `src/react/widget-entry.jsx`. Parse `script.dataset.user` as JSON (safely, with two warning branches for bad input), pass the resulting object as the `user` prop on `<DevPanel>`. No route change. No DB change. No new dashboard surface. Bundle rebuild.

**Tech Stack:** React 18, Vite (widget build), Vitest + `@testing-library/react` (already bootstrapped last task).

---

## File Structure

- **`src/react/widget-entry.jsx`** — add a `data-user` reader + JSON parse + pass as `user` prop.
- **`tests/react/widget-entry-data-user.test.jsx`** *(new)* — 4 cases: valid object, absent attr, invalid JSON, non-object JSON.
- **`dist/widget.js`** — rebuilt bundle.

---

## Task 1: widget-entry reads data-user and forwards as user prop

**Files:**
- Modify: `src/react/widget-entry.jsx`
- Create: `tests/react/widget-entry-data-user.test.jsx`

- [ ] **Step 1: Write the failing test**

Create `tests/react/widget-entry-data-user.test.jsx`:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const devPanelPropsSpy = vi.fn();
vi.mock('../../src/react/DevPanel.jsx', () => ({
  DevPanel: (props) => {
    devPanelPropsSpy(props);
    return null;
  }
}));

describe('widget-entry reads data-user', () => {
  beforeEach(() => {
    devPanelPropsSpy.mockClear();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  function installScript({ apiKey = 'dp_test', user } = {}) {
    const s = document.createElement('script');
    s.src = '/widget.js';
    s.dataset.apiKey = apiKey;
    if (user !== undefined) s.dataset.user = user;
    document.body.appendChild(s);
    return s;
  }

  // Small microtask-poll helper: createRoot().render() commits after a tick.
  async function waitForSpy() {
    for (let i = 0; i < 10 && devPanelPropsSpy.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it('passes parsed user object from data-user to DevPanel', async () => {
    installScript({ user: '{"id":"u_42","name":"Alice","email":"alice@zeno.com"}' });
    await import('../../src/react/widget-entry.jsx');
    await waitForSpy();
    expect(devPanelPropsSpy).toHaveBeenCalledTimes(1);
    expect(devPanelPropsSpy.mock.calls[0][0].user).toEqual({
      id: 'u_42',
      name: 'Alice',
      email: 'alice@zeno.com'
    });
  });

  it('passes user=null when data-user is absent', async () => {
    installScript({});
    await import('../../src/react/widget-entry.jsx');
    await waitForSpy();
    expect(devPanelPropsSpy).toHaveBeenCalledTimes(1);
    expect(devPanelPropsSpy.mock.calls[0][0].user).toBeNull();
  });

  it('warns and falls back to null when data-user is invalid JSON', async () => {
    installScript({ user: 'not json' });
    await import('../../src/react/widget-entry.jsx');
    await waitForSpy();
    expect(devPanelPropsSpy.mock.calls[0][0].user).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[DevPanel widget]'),
      expect.anything()
    );
  });

  it('warns and falls back to null when data-user is a non-object JSON value', async () => {
    installScript({ user: '"alice"' });
    await import('../../src/react/widget-entry.jsx');
    await waitForSpy();
    expect(devPanelPropsSpy.mock.calls[0][0].user).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('data-user must be a JSON object')
    );
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run tests/react/widget-entry-data-user.test.jsx`
Expected: FAIL — widget-entry doesn't read `data-user`; all 4 tests fail at the `user` prop assertion (will be undefined or absent instead of the expected value / null).

- [ ] **Step 3: Update `src/react/widget-entry.jsx`**

Replace the `mount()` function body entirely. Current file (~50 lines) and new `mount()` below. Copy the whole block, replacing lines 15-42:

```jsx
function mount() {
  const script = document.currentScript
    ?? document.querySelector('script[src*="/widget.js"][data-api-key]');

  if (document.getElementById(ROOT_ID)) {
    const existing = document.getElementById(ROOT_ID).dataset.apiKey;
    if (script?.dataset?.apiKey && existing && script.dataset.apiKey !== existing) {
      console.warn('[DevPanel widget] already mounted with a different apiKey; ignoring second <script>.');
    }
    return;
  }
  const apiKey      = script?.dataset?.apiKey;
  const apiUrl      = script?.dataset?.apiUrl;
  const environment = script?.dataset?.environment;

  let user = null;
  if (script?.dataset?.user) {
    try {
      const parsed = JSON.parse(script.dataset.user);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        user = parsed;
      } else {
        console.warn('[DevPanel widget] data-user must be a JSON object; ignoring.');
      }
    } catch (err) {
      console.warn('[DevPanel widget] data-user is not valid JSON; ignoring.', err.message);
    }
  }

  if (!apiKey) {
    console.warn('[DevPanel widget] data-api-key missing on <script>, not mounting.');
    return;
  }

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.dataset.apiKey = apiKey;
  document.body.appendChild(root);
  createRoot(root).render(
    <DevPanel apiKey={apiKey} apiUrl={apiUrl} environment={environment} user={user} />
  );
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run tests/react/widget-entry-data-user.test.jsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Re-run existing widget-entry tests to catch regressions**

Run: `npx vitest run tests/react/widget-entry-environment.test.jsx tests/react/devpanel-environment.test.jsx tests/react/reporterPayload.test.js`
Expected: all existing react tests still PASS (2 + 4 + 11 = 17 tests).

- [ ] **Step 6: Commit**

```bash
git add src/react/widget-entry.jsx tests/react/widget-entry-data-user.test.jsx
git commit -m "feat(widget): data-user on standalone script tag"
```

---

## Task 2: Rebuild the widget bundle

**Files:**
- Modify: `dist/widget.js`

- [ ] **Step 1: Build the widget**

Run: `npm run build:widget`
Expected: Vite rebuilds `dist/widget.js`.

- [ ] **Step 2: Confirm the built bundle references data-user**

Run: `grep -c "data-user\|dataset.user\|\"user\"" dist/widget.js`
Expected: at least 1 match (minifier may rename, but one of the three patterns should survive).

Alternative sanity check: `grep -c "must be a JSON object" dist/widget.js`
Expected: exactly 1 (the warning string literal survives minification).

- [ ] **Step 3: Size check**

Run: `wc -c dist/widget.js`
Expected: 420-460 KB (within ~5% of previous 425,905 bytes — the change is ~10 lines of JSX).

- [ ] **Step 4: Commit**

Stage only `dist/widget.js`.

```bash
git add dist/widget.js
git commit -m "chore(widget): rebuild bundle with data-user support"
```

---

## Self-Review

1. **Spec §1 widget-entry parse block** → Task 1 implements the exact parse, warn, and prop-forwarding logic.
2. **Spec §4 backward compat table** → all 4 rows are exercised by the 4 test cases in Task 1 (valid object, absent, invalid JSON, non-object JSON).
3. **Spec §2 usage from a host** — no code change required; usage is a consumer concern.
4. **Spec §3 wire format unchanged** — verified by the fact that DevPanel's `user` prop, `buildCaptureRequestPayload`, routes and DB are untouched in both tasks.
5. **Files touched** list in spec matches plan's file structure.

No placeholders. All code shown in full. Test imports proven in sibling file `widget-entry-environment.test.jsx`. The `waitForSpy` helper is copied from that file (same React 18 async-render constraint). Task 2's grep has a fallback strategy because minifiers can rewrite string literals aggressively — we anchor on the untouchable warning message as a secondary signal.
