import { z } from 'zod';
import { spawn } from 'node:child_process';

const HOSTS = {
  'hetzner-vps': 'deploy@62.238.0.167',
  services: 'deploy@77.42.46.87',
};

const COMMANDS = {
  'redis-ping': 'docker exec devpanel-redis redis-cli ping',
  'health-json': 'cat /home/deploy/logs/telegram-multi/health.json',
  'git-status': 'cd ~/dev-panel && git status -s',
  'compose-ps': 'cd ~/dev-panel && docker compose ps --format json',
  'deploy-agents-dry':
    'cd ~/dev-panel && bash scripts/deploy-agents.sh --dry-run',
};

function execSsh(target, command, { timeoutMs = 30_000 } = {}) {
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

export const runRemoteCheck = {
  name: 'run_remote_check',
  description: `Run a whitelisted health check on a remote host. command_id is one of: ${Object.keys(COMMANDS).join(', ')}. Free-form shell is deliberately not supported — extend src/capabilities/run-remote-check.js#COMMANDS to add a new check.`,
  paramSchema: z.object({
    host: z.enum(Object.keys(HOSTS)),
    command_id: z.enum(Object.keys(COMMANDS)),
  }),
  renderHint: 'CommandResult',
  replaces: ['run_remote'],
  async handler({ host, command_id }) {
    const target = HOSTS[host];
    const cmd = COMMANDS[command_id];
    const r = await execSsh(target, cmd, { timeoutMs: 30_000 });
    return {
      host,
      command_id,
      stdout: r.stdout,
      stderr: r.stderr,
      exit_code: r.exitCode,
      duration_ms: r.durationMs,
    };
  },
};
