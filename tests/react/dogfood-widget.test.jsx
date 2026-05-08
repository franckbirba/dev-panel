// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { DogfoodWidget } from '../../src/dashboard/components/dogfood-widget.jsx';
import { DevPanel } from '../../src/react/DevPanel.jsx';

// DogfoodWidget is a pure (no-hook) functional component, so we can call it
// directly and inspect the React element it returns. This sidesteps the
// React 19 / @testing-library/react `React.act` incompat (memory 9784e266
// — same failure mode documented for tests/react/devpanel-environment.test.jsx).

describe('DogfoodWidget — dev-panel dashboard self-mount (DEVPA-167)', () => {
  it('returns null when apiKey is empty (no project selected)', () => {
    expect(DogfoodWidget({ apiUrl: 'http://test', apiKey: '', hostname: 'dev-panel.devpanl.dev' })).toBeNull();
  });

  it('returns null when apiKey is missing entirely', () => {
    expect(DogfoodWidget({ apiUrl: 'http://test', hostname: 'dev-panel.devpanl.dev' })).toBeNull();
  });

  it('returns a <DevPanel chat /> element when apiKey is set', () => {
    const el = DogfoodWidget({ apiUrl: 'http://test', apiKey: 'dp_test', hostname: 'dev-panel.devpanl.dev' });
    expect(el).not.toBeNull();
    expect(el.type).toBe(DevPanel);
    expect(el.props.chat).toBe(true);
    expect(el.props.apiKey).toBe('dp_test');
    expect(el.props.apiUrl).toBe('http://test');
  });

  it('forwards environment="production" for the devpanl.dev hostname', () => {
    const el = DogfoodWidget({ apiUrl: 'http://x', apiKey: 'dp_test', hostname: 'dev-panel.devpanl.dev' });
    expect(el.props.environment).toBe('production');
  });

  it('forwards environment="production" for any *.devpanl.dev hostname', () => {
    const el = DogfoodWidget({ apiUrl: 'http://x', apiKey: 'dp_test', hostname: 'staging.devpanl.dev' });
    expect(el.props.environment).toBe('production');
  });

  it('forwards environment="development" for localhost', () => {
    const el = DogfoodWidget({ apiUrl: 'http://localhost:3030', apiKey: 'dp_test', hostname: 'localhost' });
    expect(el.props.environment).toBe('development');
  });

  it('forwards environment="development" for 127.0.0.1', () => {
    const el = DogfoodWidget({ apiUrl: 'http://127.0.0.1:3030', apiKey: 'dp_test', hostname: '127.0.0.1' });
    expect(el.props.environment).toBe('development');
  });

  it('omits environment for unknown hostnames so captures are not mislabelled', () => {
    const el = DogfoodWidget({ apiUrl: 'http://x', apiKey: 'dp_test', hostname: 'some.other.host' });
    expect(el.props.environment).toBeUndefined();
  });
});
