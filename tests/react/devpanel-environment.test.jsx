// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { DevPanel } from '../../src/react/DevPanel.jsx';

describe('DevPanel environment forwarding', () => {
  let originalFetch;
  let fetchCalls;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchCalls = [];
    global.fetch = vi.fn(async (url, init) => {
      fetchCalls.push([url, init]);
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: 'cap_1' })
      };
    });
    Object.defineProperty(global.navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn() },
      configurable: true
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
  });

  async function openBugFormAndSubmit(props) {
    render(<DevPanel apiUrl="http://test" apiKey="dp_test" {...props} />);
    fireEvent.click(screen.getByLabelText('DevPanel'));
    fireEvent.click(screen.getByText(/Report Bug/i));
    const textarea = await screen.findByPlaceholderText(/describe|bug|issue|wrong/i);
    fireEvent.change(textarea, { target: { value: 'something broke' } });
    fireEvent.click(screen.getByRole('button', { name: /submit bug report/i }));
    await waitFor(() => {
      const captureCall = fetchCalls.find(c => String(c[0]).endsWith('/api/captures'));
      expect(captureCall).toBeDefined();
    });
    const captureCall = fetchCalls.find(c => String(c[0]).endsWith('/api/captures'));
    return JSON.parse(captureCall[1].body);
  }

  it('includes environment in the POST body when `environment` prop is passed', async () => {
    const body = await openBugFormAndSubmit({ environment: 'production' });
    expect(body.environment).toBe('production');
  });

  it('omits environment when `environment` prop is not passed', async () => {
    const body = await openBugFormAndSubmit({});
    expect(body.environment).toBeUndefined();
  });

  it('omits environment when `environment` prop is not a string', async () => {
    const body = await openBugFormAndSubmit({ environment: 42 });
    expect(body.environment).toBeUndefined();
  });

  it('carries both user and environment together', async () => {
    const body = await openBugFormAndSubmit({
      user: { id: 'u_1', name: 'Alice' },
      environment: 'staging'
    });
    expect(body.reporter).toEqual({ id: 'u_1', name: 'Alice' });
    expect(body.environment).toBe('staging');
  });
});
