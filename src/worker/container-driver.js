// src/worker/container-driver.js
//
// DEVPA-230 + 231: ContainerDriver — run an ephemeral claude/pi inside a
// devpanel-worker Docker container instead of natively on the agents host.
//
// Same contract as spawnPi/spawnMiniSwe: returns Promise<string> resolving
// with the final result text on exit 0, rejects with stderr tail on non-zero.
//
// Gate: shouldUseContainer(agentRole) — DRIVER_<AGENT>=container or
// DRIVER_DEFAULT=container. Per-role overrides (claude/pi/goose/mini) and
// FORCE_TIER=opus still win.

import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { createStreamParser, getFinalResultText, classifyEvent } from './stream-parser.js';
import { appendEvent, broadcastDone } from '../server/jobs-events.js';

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || 'devpanel/worker:latest';

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

export function spawnContainer({ jobId, prompt, agentRole = 'unknown', cwd, activeProcesses, agentLogDir, meta = {} }) {
  return new Promise((resolve, reject) => {
    const containerName = `agent-${jobId}`;
    const mcpConfigHost = process.env.WORKER_MCP_CONFIG
      || join(process.env.HOME || '/home/deploy', '.mcp-worker.json');

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

    if (meta.work_item_id) dockerArgs.push('-e', `WORK_ITEM_ID=${meta.work_item_id}`);
    if (meta.workflow_name) dockerArgs.push('-e', `WORKFLOW_NAME=${meta.workflow_name}`);

    for (const k of ENV_PASSTHROUGH) {
      if (process.env[k] != null && process.env[k] !== '') {
        dockerArgs.push('-e', `${k}=${process.env[k]}`);
      }
    }

    dockerArgs.push(CONTAINER_IMAGE);
    // The image's entrypoint is the claude CLI; stdin carries the prompt so
    // we don't blow shell arg length on long prompts.
    dockerArgs.push(
      'claude', '-p', prompt,
      '--strict-mcp-config',
      '--mcp-config', '/etc/devpanel/mcp.json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    );

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
        // Make sure no zombie container survives a crash. `docker rm -f` is
        // a no-op if the container already exited cleanly.
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
