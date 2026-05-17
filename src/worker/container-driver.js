// src/worker/container-driver.js
//
// DEVPA-230 + 231: ContainerDriver — run an ephemeral claude/pi inside a
// devpanel-worker Docker container instead of natively on the agents host.
//
// Same contract as spawnPi/spawnMiniSwe: returns Promise<string> resolving
// with the final result text on exit 0, rejects with stderr tail on non-zero.
//
// Two orthogonal axes:
//   - WHETHER to containerize: shouldUseContainer(agentRole) — gated on
//     DRIVER_<AGENT>=container or DRIVER_DEFAULT=container.
//   - WHICH CLI runs inside: CONTAINER_INNER_DRIVER=claude|pi (default
//     claude). pi inside the container reuses the same selectPiModel +
//     readSoul + extension surface as the native pi-driver, but the
//     pi-extensions tree is bind-mounted ro from the host.

import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { createStreamParser, getFinalResultText, classifyEvent } from './stream-parser.js';
import { appendEvent, broadcastDone } from '../server/jobs-events.js';
import { readSoul } from './prompt-builder.js';
import { selectPiModel } from './select-pi-model.js';

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'devpanel/worker:latest';
const INNER_DRIVER = (process.env.CONTAINER_INNER_DRIVER || 'claude').toLowerCase();

// Mirror pi-driver.js — keep in sync if extensions change.
const PI_BUILTIN_ALLOWLIST = 'read,edit,grep,find,ls,bash';
const PI_EXTENSION_NAMES = [
  'mcp-bridge', 'work-items', 'github', 'bash', 'loop-guard', 'create-file',
];

const ENV_PASSTHROUGH = [
  'REDIS_HOST', 'REDIS_PORT', 'PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE',
  'API_BASE', 'ADMIN_API_KEY', 'DEVPANEL_API_KEY',
  'PLANE_BASE_URL', 'PLANE_WORKSPACE_SLUG', 'PLANE_API_KEY', 'PLANE_PROJECT_ID',
  'GITHUB_TOKEN', 'GH_TOKEN',
  'ANTHROPIC_API_KEY', 'DEEPINFRA_API_KEY', 'OPENAI_API_KEY',
  'GOOSE_PROVIDER', 'GOOSE_BASE_URL', 'GOOSE_MODEL',
  'GLITCHTIP_BASE_URL', 'GLITCHTIP_API_TOKEN',
];

export function shouldUseContainer(agentRole) {
  if (process.env.FORCE_TIER === 'opus') return false;
  const role = (agentRole || '').toUpperCase().replace(/-/g, '_');
  const perRole = process.env[`DRIVER_${role}`];
  if (perRole) return perRole === 'container';
  return process.env.DRIVER_DEFAULT === 'container';
}

function buildClaudeArgv(prompt) {
  return [
    'claude', '-p', prompt,
    '--strict-mcp-config',
    '--mcp-config', '/etc/devpanel/mcp.json',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
}

function buildPiArgv(prompt, agentRole) {
  const selected = selectPiModel(agentRole);
  if (!selected) {
    throw new Error(`container-driver: CONTAINER_INNER_DRIVER=pi but no model selected for role "${agentRole}" — set DRIVER_${agentRole.toUpperCase()}_PI_MODEL or FORCE_PI_MODEL`);
  }
  const { provider, model } = selected;
  const soul = readSoul(agentRole);
  // Pi extensions are bind-mounted at /opt/pi-extensions inside the container
  // (see spawnContainer below). Same order + flags as src/worker/pi-driver.js
  // so the in-container pi behaves identically to the native one.
  const extensionFlags = PI_EXTENSION_NAMES.flatMap(
    name => ['--extension', `/opt/pi-extensions/${name}`],
  );
  return [
    'pi',
    '--provider', provider,
    '--model', model,
    '--mode', 'json',
    '--no-session',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--tools', PI_BUILTIN_ALLOWLIST,
    ...extensionFlags,
    '--append-system-prompt', soul,
    '-p', prompt,
  ];
}

export function spawnContainer({ jobId, prompt, agentRole = 'unknown', cwd, activeProcesses, agentLogDir, meta = {} }) {
  return new Promise((resolve, reject) => {
    const containerName = `agent-${jobId}`;
    const mcpConfigHost = process.env.WORKER_MCP_CONFIG
      || join(process.env.HOME || '/home/deploy', '.mcp-worker.json');
    const piExtensionsHost = process.env.PI_EXTENSIONS_ROOT
      || join(process.env.PROJECT_ROOT || process.cwd(), 'infra/pi-extensions');

    const dockerArgs = [
      'run', '--rm', '-i',
      '--name', containerName,
      '--network', 'host',
      '-v', `${cwd}:/workspace`,
      '-w', '/workspace',
      '-v', `${mcpConfigHost}:/etc/devpanel/mcp.json:ro`,
      '-e', `JOB_ID=${jobId}`,
      '-e', `AGENT_ROLE=${agentRole}`,
      '-e', 'WORKER_MCP_CONFIG=/etc/devpanel/mcp.json',
    ];

    if (INNER_DRIVER === 'pi') {
      // pi reads PI_MCP_CONFIG to know which mcp.json mcp-bridge should
      // load. Inside the container that's the same file as WORKER_MCP_CONFIG.
      dockerArgs.push(
        '-v', `${piExtensionsHost}:/opt/pi-extensions:ro`,
        '-e', 'PI_MCP_CONFIG=/etc/devpanel/mcp.json',
      );
    }

    if (meta.work_item_id) dockerArgs.push('-e', `WORK_ITEM_ID=${meta.work_item_id}`);
    if (meta.workflow_name) dockerArgs.push('-e', `WORKFLOW_NAME=${meta.workflow_name}`);

    for (const k of ENV_PASSTHROUGH) {
      if (process.env[k] != null && process.env[k] !== '') {
        dockerArgs.push('-e', `${k}=${process.env[k]}`);
      }
    }

    dockerArgs.push(CONTAINER_IMAGE);

    let innerArgv;
    try {
      innerArgv = INNER_DRIVER === 'pi'
        ? buildPiArgv(prompt, agentRole)
        : buildClaudeArgv(prompt);
    } catch (err) {
      return reject(err);
    }
    dockerArgs.push(...innerArgv);

    const proc = spawn('docker', dockerArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeProcesses.set(jobId, { process: proc, startedAt: Date.now(), containerName });

    const events = [];
    const parser = createStreamParser(({ seq, event }) => {
      events.push(event);
      const { event_type, event_subtype } = classifyEvent(event);
      appendEvent({ job_id: String(jobId), seq, event_type, event_subtype, payload: event })
        .catch(err => console.error('[container-driver] appendEvent failed', seq, err.message));
    });

    const errLogPath = join(agentLogDir, `${jobId}.err.log`);
    const errStream = createWriteStream(errLogPath, { flags: 'a' });
    let stderrTail = '';

    proc.stdout.on('data', (chunk) => parser.push(chunk));
    proc.stderr.on('data', (chunk) => {
      errStream.write(chunk);
      stderrTail += chunk.toString();
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });

    proc.on('close', (code) => {
      activeProcesses.delete(jobId);
      parser.flush();
      errStream.end();
      broadcastDone(String(jobId), { exit_code: code, events: events.length });
      if (code === 0) {
        resolve(getFinalResultText(events));
      } else {
        try { spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' }); } catch { /* ignore */ }
        reject(new Error(`container ${containerName} exited with code ${code}\nstderr: ${stderrTail.slice(-1000)}`));
      }
    });

    proc.on('error', (err) => {
      activeProcesses.delete(jobId);
      errStream.end();
      broadcastDone(String(jobId), { exit_code: null, error: err.message });
      reject(err);
    });
  });
}
