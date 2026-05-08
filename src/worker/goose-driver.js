// src/worker/goose-driver.js
// Phase A goose harness driver. Spawns `goose run` against an OpenAI-compatible
// provider (DeepInfra → Qwen3-Coder-480B). Same external contract as the
// existing claude `spawnAgent`:
//
//   - returns final stdout text on exit 0
//   - rejects on non-zero exit
//   - writes raw stderr to storage/agent-logs/<job>.err.log
//   - persists synthetic events via appendEvent so the dashboard timeline
//     keeps working (goose doesn't emit Claude-shaped stream-json)
//   - registers the child in `activeProcesses` so cancel_job works
//
// Phase B will hoist this into src/worker/drivers/goose.js with a proper
// AgentSpec contract. For now: single function, env-gated.
import { spawn } from 'child_process';
import { createWriteStream, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { appendEvent, broadcastDone } from '../server/jobs-events.js';

const DEFAULT_PROVIDER = 'openai';
const DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1/openai';
// Turbo (FP4) over non-Turbo (FP8): identical 480B/35B-active arch, $0.30/$1.00
// vs $0.40/$1.60, $0.10/M cached input on Turbo only. FP4 quant regression on
// multi-turn tool-call arg fidelity is not publicly measured; the failure mode
// (dropped fields, fabricated tool names) is driven by attention drift over
// long context, which hits FP8 identically. Revisit if we log measurable
// arg-fidelity regression at turn 6+.
const DEFAULT_MODEL = 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo';

function envForGoose() {
  return {
    GOOSE_PROVIDER: process.env.GOOSE_PROVIDER || DEFAULT_PROVIDER,
    GOOSE_BASE_URL: process.env.GOOSE_BASE_URL || DEFAULT_BASE_URL,
    GOOSE_MODEL: process.env.GOOSE_MODEL || DEFAULT_MODEL,
    OPENAI_BASE_URL: process.env.GOOSE_BASE_URL || DEFAULT_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || process.env.DEEPINFRA_API_KEY || '',
    GOOSE_MODE: process.env.GOOSE_MODE || 'auto',
  };
}

export function spawnGoose({ jobId, prompt, agentRole, cwd, activeProcesses, agentLogDir }) {
  return new Promise((resolve, reject) => {
    // Goose reads the prompt from a file when `-t @<path>` is used, which
    // sidesteps shell-arg-length limits. Worktree may have spaces; using a
    // tmp file keeps args boring.
    const promptDir = join(tmpdir(), 'goose-prompts');
    try { mkdirSync(promptDir, { recursive: true }); } catch { /* exists */ }
    const promptPath = join(promptDir, `${jobId}-${randomUUID()}.txt`);
    writeFileSync(promptPath, prompt, 'utf8');

    // -i <file> reads instructions from a file (per goose docs). -t is text-only
    // and does NOT interpret an @-prefix as a path — passing `-t @/tmp/foo.txt`
    // makes goose treat the literal `@/tmp/foo.txt` string as the prompt, the
    // model never sees the work item, and replies to its own welcome banner.
    // First canary on 2026-05-08 hit exactly this. Use -i.
    const proc = spawn('goose', [
      'run',
      '--no-session',
      '-i', promptPath,
    ], {
      cwd,
      env: {
        ...process.env,
        ...envForGoose(),
        JOB_ID: jobId,
        AGENT_ROLE: agentRole,
        PATH: [
          join(process.env.HOME || '/home/deploy', '.local/bin'),
          join(process.env.HOME || '/home/deploy', '.bun/bin'),
          join(process.env.HOME || '/home/deploy', '.npm-global/bin'),
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
        ].join(':'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeProcesses.set(jobId, { process: proc, startedAt: Date.now() });

    let stdoutBuf = '';
    let seq = 0;
    const errLogPath = join(agentLogDir, `${jobId}.err.log`);
    const errStream = createWriteStream(errLogPath, { flags: 'a' });
    let stderrTail = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      const event = {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        harness: 'goose',
      };
      appendEvent({
        job_id: String(jobId),
        seq: seq++,
        event_type: 'assistant',
        event_subtype: 'text',
        payload: event,
      }).catch(err => console.error('[goose] appendEvent failed', err.message));
    });

    proc.stderr.on('data', (chunk) => {
      errStream.write(chunk);
      stderrTail += chunk.toString();
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });

    proc.on('close', (code) => {
      activeProcesses.delete(jobId);
      errStream.end();
      // Final synthetic `result` event so getFinalResultText-style consumers
      // and the dashboard see a terminal entry.
      appendEvent({
        job_id: String(jobId),
        seq: seq++,
        event_type: 'result',
        event_subtype: code === 0 ? 'success' : 'error',
        payload: { type: 'result', result: stdoutBuf, exit_code: code, harness: 'goose' },
      }).catch(() => {});
      broadcastDone(String(jobId), { exit_code: code, events: seq });
      if (code === 0) {
        resolve(stdoutBuf);
      } else {
        reject(new Error(`goose run exited with code ${code}\nstderr: ${stderrTail.slice(-1000)}`));
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

export function shouldUseGoose(agentRole) {
  if (process.env.FORCE_TIER === 'opus') return false;
  const envKey = `DRIVER_${agentRole.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[envKey] === 'goose') return true;
  if (process.env[envKey] === 'claude') return false;
  return process.env.DRIVER_DEFAULT === 'goose';
}
