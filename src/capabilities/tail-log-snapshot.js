import { z } from 'zod';
import { execSsh } from '../lib/exec-ssh.js';

const HOSTS = {
  'hetzner-vps': 'deploy@62.238.0.167',
  services: 'deploy@77.42.46.87',
};

export const tailLogSnapshot = {
  name: 'tail_log_snapshot',
  description:
    'Snapshot of the last N lines of journalctl for a unit on a known host. Synchronous. For live tailing, RuntimeConsoleCard subscribes to /api/runtime/tail-log SSE — this verb is the "give me the last 50 lines" companion.',
  paramSchema: z.object({
    host: z.enum(Object.keys(HOSTS)).describe('Target host: "hetzner-vps" or "services".'),
    unit: z
      .string()
      .regex(/^[a-zA-Z0-9@._+-]+$/, 'unit must be a systemd unit name')
      .describe('systemd unit name, e.g. "shelly.service", "devpanel-worker.service", "glitchtip-web". Template units like "foo@bar.service" are allowed.'),
    lines: z.number().int().min(1).max(500).default(50)
      .describe('How many tail lines to fetch (1-500).'),
  }),
  renderHint: 'RuntimeConsole',
  replaces: ['tail_log'],
  async handler({ host, unit, lines = 50 }) {
    const target = HOSTS[host];
    const r = await execSsh(
      target,
      `journalctl -u ${unit} -n ${lines} --no-pager`,
      { timeoutMs: 20_000 }
    );
    if (r.exitCode !== 0) {
      throw new Error(`journalctl exit ${r.exitCode}: ${r.stderr || r.stdout}`);
    }
    return {
      host,
      unit,
      title: `${unit} @ ${host}`,
      state: 'connected',
      lines: r.stdout.split('\n').filter(Boolean),
    };
  },
};
