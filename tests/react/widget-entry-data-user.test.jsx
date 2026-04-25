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
