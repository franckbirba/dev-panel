import { z } from 'zod';
import { spawn } from 'node:child_process';

const HOSTS = {
  'hetzner-vps': 'deploy@62.238.0.167',
  services: 'deploy@77.42.46.87',
};

function execSsh(target, command, { timeoutMs = 15_000 } = {}) {
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

export const hostStatus = {
  name: 'host_status',
  description:
    'Quick-glance host health: load avg, memory, top container CPU/mem. Use for "ça va sur services?" / "comment va le VPS agents?".',
  paramSchema: z.object({
    host: z.enum(Object.keys(HOSTS)),
  }),
  renderHint: 'HostStatus',
  replaces: ['ssh_status'],
  async handler({ host }) {
    const target = HOSTS[host];
    const cmd = [
      'uptime',
      'echo "---"',
      'free -h',
      'echo "---"',
      "docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' | head -10",
    ].join('; ');
    const r = await execSsh(target, cmd, { timeoutMs: 15_000 });
    if (r.exitCode !== 0) {
      throw new Error(`ssh exit ${r.exitCode}: ${r.stderr || r.stdout}`);
    }
    const sections = r.stdout.split(/^---$/m).map((s) => s.trim());
    const [uptimeOut = '', memOut = '', dockerOut = ''] = sections;

    const loadMatch = uptimeOut.match(
      /load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/
    );
    const load = loadMatch
      ? { '1m': +loadMatch[1], '5m': +loadMatch[2], '15m': +loadMatch[3] }
      : null;

    const memLine = memOut.split('\n').find((l) => /^Mem:/.test(l));
    const memCols = memLine ? memLine.trim().split(/\s+/) : null;
    const memory = memCols
      ? {
          total: memCols[1],
          used: memCols[2],
          free: memCols[3],
          available: memCols[6],
        }
      : null;

    const containers = dockerOut
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const parts = l.split(/\s+/);
        return {
          name: parts[0],
          cpu: parts[1],
          memory: parts.slice(2).join(' '),
        };
      });

    return { host, load, memory, containers };
  },
};
