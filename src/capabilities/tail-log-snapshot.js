import { z } from 'zod';
import { spawn } from 'node:child_process';

const HOSTS = {
  'hetzner-vps': 'deploy@62.238.0.167',
  services: 'deploy@77.42.46.87',
};

function execSsh(target, command, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('ssh', [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=accept-new',
      target,
      command,
    ]);
    let stdout = '';
    let stderr = '';
    const start = Date.now();
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        stdout,
        stderr: stderr + '\n[timeout]',
        exitCode: -1,
        durationMs: Date.now() - start,
      });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        durationMs: Date.now() - start,
      });
    });
  });
}

export const tailLogSnapshot = {
  name: 'tail_log_snapshot',
  description:
    'Snapshot of the last N lines of journalctl for a unit on a known host. Synchronous. For live tailing, RuntimeConsoleCard subscribes to /api/runtime/tail-log SSE — this verb is the "give me the last 50 lines" companion.',
  paramSchema: z.object({
    host: z.enum(Object.keys(HOSTS)),
    unit: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+$/, 'unit must be alphanumeric/_/-/.'),
    lines: z.number().int().min(1).max(500).default(50),
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
