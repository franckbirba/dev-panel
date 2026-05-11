import { describe, it, expect } from 'vitest';
import { tailLogSnapshot } from '../../src/capabilities/tail-log-snapshot.js';

// The unit regex used to reject every systemd template unit (the `@` in
// `foo@bar.service`) and some legitimate service names. Loosened to
// `[a-zA-Z0-9@._+-]+`. This test pins the acceptance set so we don't
// drift back to the old rejection on a future cleanup.

describe('tail_log_snapshot paramSchema.unit', () => {
  const schema = tailLogSnapshot.paramSchema;

  it.each([
    'shelly.service',
    'devpanel-worker.service',
    'glitchtip-web',
    'getty@tty1.service',
    'systemd-networkd',
    'docker.service',
    'cron+watch.service',
  ])('accepts %s', (unit) => {
    const r = schema.safeParse({ host: 'services', unit, lines: 50 });
    expect(r.success, `${unit} should be accepted: ${JSON.stringify(r.error?.issues)}`).toBe(
      true
    );
  });

  it.each([
    '',
    'foo bar',
    'foo;bar',
    'foo/bar',
    'foo|bar',
    'foo$(rm)',
  ])('rejects %s', (unit) => {
    const r = schema.safeParse({ host: 'services', unit, lines: 50 });
    expect(r.success).toBe(false);
  });

  it('defaults lines to 50', () => {
    const r = schema.safeParse({ host: 'services', unit: 'shelly.service' });
    expect(r.success).toBe(true);
    expect(r.data.lines).toBe(50);
  });

  it('caps lines at 500', () => {
    const r = schema.safeParse({ host: 'services', unit: 'shelly.service', lines: 5000 });
    expect(r.success).toBe(false);
  });
});
