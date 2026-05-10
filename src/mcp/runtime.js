// Runtime MCP tools — replace 5 of the 9 windows in scripts/tmux-cockpit.sh.
//
//   tail_log    — SSH + journalctl streamer (DEVPA-201)
//   run_remote  — whitelisted SSH commands  (DEVPA-202)
//   ssh_status  — quick host health bundle  (DEVPA-203)
//
// Hard rules:
//   - Host names are an enum; no free-form host strings ever reach ssh.
//   - Commands are picked from a whitelist by id, not assembled from
//     request input. The tmux script is for ad-hoc — these tools are for
//     anything that needs to be invokable from chat, agents, or other
//     scripts safely.
//   - Auth piggybacks on the SSH keys the agents host already has for
//     deploy@<host>. No credentials in this file or in MCP requests.

import { spawn } from 'node:child_process';
import { z } from 'zod';

const HOSTS = {
  'hetzner-vps': 'deploy@62.238.0.167',
  'services':    'deploy@77.42.46.87',
  'zeno-prod':   'deploy@77.42.46.87', // same host, conventionally separate
};

const HostSchema = z.enum(Object.keys(HOSTS));

// Whitelisted shell snippets for run_remote. Add only commands that are
// safe to call N times concurrently with no destructive side effects.
const COMMANDS = {
  'redis-ping':       'docker exec devpanel-redis redis-cli ping',
  'health-json':      'cat /home/deploy/logs/telegram-multi/health.json',
  'git-status':       'cd ~/dev-panel && git status -s',
  'compose-ps':       'cd ~/dev-panel && docker compose ps --format json',
  'deploy-agents-dry': 'cd ~/dev-panel && bash scripts/deploy-agents.sh --dry-run',
};

const RunRemoteSchema = z.object({
  host: HostSchema,
  command_id: z.enum(Object.keys(COMMANDS)),
});

const TailLogSchema = z.object({
  host: HostSchema,
  unit: z.string().regex(/^[a-zA-Z0-9._-]+$/, 'unit must be alphanumeric/_/-/.'),
  lines: z.number().int().min(1).max(500).default(50),
});

const SshStatusSchema = z.object({ host: HostSchema });

function execSsh(target, command, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new',
      target,
      command,
    ]);
    let stdout = '';
    let stderr = '';
    const start = Date.now();
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({
        stdout, stderr: stderr + '\n[timeout]',
        exitCode: -1, durationMs: Date.now() - start,
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 0, durationMs: Date.now() - start });
    });
  });
}

export function registerRuntimeTools(server) {
  server.tool(
    'tail_log',
    'Tail journalctl on a remote host. Returns the last N lines synchronously (the streaming path lives behind a /api/runtime/tail-log SSE endpoint paired with RuntimeConsoleCard).',
    TailLogSchema.shape,
    async ({ host, unit, lines }) => {
      const target = HOSTS[host];
      const result = await execSsh(
        target,
        `journalctl -u ${unit} -n ${lines} --no-pager`,
        { timeoutMs: 20_000 },
      );
      if (result.exitCode !== 0) {
        return {
          content: [{
            type: 'text',
            text: `tail_log failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            host, unit, lines: result.stdout.split('\n').filter(Boolean),
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    'run_remote',
    `Run a whitelisted command on a remote host. Allowed command_ids: ${Object.keys(COMMANDS).join(', ')}. Free-form commands are deliberately not supported — extend src/mcp/runtime.js#COMMANDS to add one.`,
    RunRemoteSchema.shape,
    async ({ host, command_id }) => {
      const target = HOSTS[host];
      const cmd = COMMANDS[command_id];
      const result = await execSsh(target, cmd, { timeoutMs: 30_000 });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            host, command_id,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          }, null, 2),
        }],
        isError: result.exitCode !== 0,
      };
    },
  );

  server.tool(
    'ssh_status',
    'Quick-glance host health: load avg, memory, top container CPU/mem.',
    SshStatusSchema.shape,
    async ({ host }) => {
      const target = HOSTS[host];
      const cmd = [
        'uptime',
        'echo "---"',
        'free -h',
        'echo "---"',
        "docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' | head -10",
      ].join('; ');
      const result = await execSsh(target, cmd, { timeoutMs: 15_000 });
      if (result.exitCode !== 0) {
        return {
          content: [{
            type: 'text',
            text: `ssh_status failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`,
          }],
          isError: true,
        };
      }
      const sections = result.stdout.split(/^---$/m).map((s) => s.trim());
      const [uptimeOut = '', memOut = '', dockerOut = ''] = sections;

      // Parse uptime: "load average: 0.42, 0.31, 0.28"
      const loadMatch = uptimeOut.match(/load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
      const load = loadMatch
        ? { '1m': +loadMatch[1], '5m': +loadMatch[2], '15m': +loadMatch[3] }
        : null;

      // Parse `free -h`: header + Mem: line
      const memLine = memOut.split('\n').find((l) => /^Mem:/.test(l));
      const memCols = memLine ? memLine.trim().split(/\s+/) : null;
      const memory = memCols
        ? { total: memCols[1], used: memCols[2], free: memCols[3], available: memCols[6] }
        : null;

      // Parse docker stats: NAME CPU% MEM_USAGE
      const containers = dockerOut
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const parts = l.split(/\s+/);
          return { name: parts[0], cpu: parts[1], memory: parts.slice(2).join(' ') };
        });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ host, load, memory, containers }, null, 2),
        }],
      };
    },
  );
}
