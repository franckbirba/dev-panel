// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock DevPanel so we can inspect the props passed by widget-entry without
// mounting the full React tree.
const devPanelPropsSpy = vi.fn();
vi.mock('../../src/react/DevPanel.jsx', () => ({
  DevPanel: (props) => {
    devPanelPropsSpy(props);
    return null;
  }
}));

describe('widget-entry reads data-environment', () => {
  beforeEach(() => {
    devPanelPropsSpy.mockClear();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.resetModules();
  });

  function installScript({ apiKey, apiUrl, environment } = {}) {
    const s = document.createElement('script');
    s.src = '/widget.js';
    if (apiKey)      s.dataset.apiKey      = apiKey;
    if (apiUrl)      s.dataset.apiUrl      = apiUrl;
    if (environment) s.dataset.environment = environment;
    document.body.appendChild(s);
    return s;
  }

  async function waitForSpy() {
    // React 18 createRoot().render() is async; flush microtasks/timers so the
    // spy gets called before we assert. A few awaits is enough — no fake timers.
    for (let i = 0; i < 10 && devPanelPropsSpy.mock.calls.length === 0; i++) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  it('passes environment from data-environment to DevPanel', async () => {
    installScript({ apiKey: 'dp_test', environment: 'staging' });
    await import('../../src/react/widget-entry.jsx');
    await waitForSpy();
    expect(devPanelPropsSpy).toHaveBeenCalledTimes(1);
    expect(devPanelPropsSpy.mock.calls[0][0].environment).toBe('staging');
  });

  it('passes undefined environment when data-environment is missing', async () => {
    installScript({ apiKey: 'dp_test' });
    await import('../../src/react/widget-entry.jsx');
    await waitForSpy();
    expect(devPanelPropsSpy).toHaveBeenCalledTimes(1);
    expect(devPanelPropsSpy.mock.calls[0][0].environment).toBeUndefined();
  });
});
