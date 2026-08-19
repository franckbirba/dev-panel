import { z } from 'zod';
import { execSsh } from '../lib/exec-ssh.js';

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
