// src/worker/mini-swe-driver.js
//
// mini-swe-agent harness driver. Spawns `mini -c default.yaml --yolo` against
// an OpenAI-compat endpoint (DeepInfra → Qwen3-Coder-480B) for routine builder
// work. Replaces the goose-driver path.
//
// Why mini-swe-agent over goose:
//
//  Empirical canary on agents host (2026-05-09 01:30-01:35):
//    Task: "Add a one-line comment to README.md, git add, git commit -m canary"
//
//                     │  goose × Qwen3 (yesterday)  │  mini-swe × Qwen3 (now)
//    ─────────────────┼────────────────────────────┼─────────────────────────
//    Wall time        │  17+ min, never finished   │  40 sec
//    API calls        │  ~600 events streamed      │  7
//    Tokens used      │  177M (cached)             │  ~4 261
//    Cost per task    │  $3-5 (median over canary) │  ~$0.002
//    Result           │  no diff, no commit        │  real commit, real diff
//    Closing protocol │  prose-prompt, ignored 30% │  structural — only exit
//
// The closing protocol is the structural fix we couldn't get from goose's
// recipe.instructions. mini-swe-agent's `default.yaml` requires the agent to
// emit exactly `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` to terminate;
// any other "I'm done" claim is rejected by the harness, not by us. Combined
// with the worker-side verifyAndCommit gate (src/worker/automation.js:155),
// we now have two structural barriers between the model and a fake "done".
//
// External contract is unchanged from goose-driver: resolves with the final
// stdout text on exit 0, rejects with stderr tail on non-zero, registers in
// activeProcesses for cancel_job, writes raw stderr to
// storage/agent-logs/<job>.err.log, persists synthetic events through
// appendEvent so the dashboard timeline still renders.
import { spawn } from 'child_process';
import { createWriteStream, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { appendEvent, broadcastDone } from '../server/jobs-events.js';
import { readSoul, parseResult } from './prompt-builder.js';

const DEFAULT_PROVIDER = 'openai';
const DEFAULT_BASE_URL = 'https://api.deepinfra.com/v1/openai';
const DEFAULT_MODEL    = 'openai/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo';
// Hard ceiling per spawn — pairs with mini-swe's own --cost-limit and our
// upstream verifyAndCommit. If a single builder run blows past $0.50, we
// want to crash, not silently accumulate canary 2080-style $18 burn.
const DEFAULT_COST_LIMIT = process.env.MINI_SWE_COST_LIMIT || '0.50';
// Trajectory file written by mini at end of run — JSON with messages,
// info.model_stats {api_calls, instance_cost}, info.exit_status, etc.
const TRAJ_PATH = join(homedir(), '.config', 'mini-swe-agent', 'last_mini_run.traj.json');

// We bundle SOUL + the per-job prompt into mini's `-t` flag. mini-swe-agent's
// default.yaml `instance_template` interpolates `{{task}}` into a structured
// system prompt, so we don't try to fight it — we just give it the full
// instruction stream and let its harness handle the loop.
function buildMiniTask({ agentRole, prompt }) {
  const soul = readSoul(agentRole);
  return [
    soul,
    '',
    '---',
    '',
    prompt,
    '',
    '---',
    '',
    'IMPORTANT: When work is complete, you MUST commit your changes:',
    '  1. `git status --short` to see changes',
    '  2. `git add <files>` (never `git add -A` or `git add .`)',
    '  3. `git commit -m "<conventional message>"`',
    '  4. `git diff --stat origin/main...HEAD` to verify the diff is real',
    'Only after the commit lands do you issue:',
    '  `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`',
    '',
    'The orchestration runs a verifier that checks the diff after you exit.',
    'Returning without a real diff vs origin/main will be downgraded to blocked.',
  ].join('\n');
}

// Synthesize the parseResult-shaped JSON our worker pipeline expects.
// mini-swe-agent itself doesn't emit our schema (it's a generic SWE-bench
// harness), so we read its trajectory file and translate. The verifier in
// automation.js will then run `git diff --quiet origin/main...HEAD`
// against `cwd` and downgrade to blocked if no diff materialized.
function synthesizeResult({ trajPath, exitCode, agentRole }) {
  let traj = null;
  if (existsSync(trajPath)) {
    try { traj = JSON.parse(readFileSync(trajPath, 'utf8')); }
    catch (err) { console.warn(`[mini-swe] trajectory parse failed: ${err.message}`); }
  }

  const info = traj?.info || {};
  const model_stats = info.model_stats || {};
  const messages = traj?.messages || [];
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const summary = (info.submission || lastAssistant?.content || '(no summary)').slice(0, 1500);

  // Submission is mini's "final output" — we treat its presence as status=done
  // (the verifyAndCommit gate will downgrade to blocked if no diff). EOFError
  // is the benign post-completion shell prompt timing out — task already
  // succeeded by then, so still status=done. Anything else is a fail.
  const exitStatus = info.exit_status || '';
  let status = 'failed';
  if (info.submission || exitStatus === 'EOFError' || exitCode === 0) {
    status = 'done';
  }
  // mini may also surface `LimitsExceeded` if --cost-limit fired — that's
  // a structurally-blocked outcome (we ran out of budget before completion),
  // not a model failure.
  if (exitStatus === 'LimitsExceeded') status = 'blocked';

  return {
    status,
    summary,
    artifacts: {
      // We deliberately don't try to enumerate files here — verifyAndCommit
      // reads `git status --porcelain` to discover what actually changed.
      // mini doesn't track file paths in a structured way and inferring from
      // shell command history would be brittle.
      files_created: [],
      files_modified: [],
      commits: [],
      branch: null,
      tests_passed: false,
      pr_url: null,
    },
    handoff: { next_agent: null, reason: '' },
    memory_writes_count: 0,
    blockers: [],
    issues_found: [],
    // Out-of-band metadata for the dashboard — not part of the parseResult
    // contract but appendEvent persists it.
    _harness: 'mini-swe-agent',
    _api_calls: model_stats.api_calls || 0,
    _exit_status: exitStatus,
  };
}

export function spawnMiniSwe({ jobId, prompt, agentRole, cwd, activeProcesses, agentLogDir }) {
  return new Promise((resolve, reject) => {
    const task = buildMiniTask({ agentRole, prompt });
    const model = process.env.MINI_SWE_MODEL || DEFAULT_MODEL;
    const baseUrl = process.env.MINI_SWE_BASE_URL || process.env.GOOSE_BASE_URL || DEFAULT_BASE_URL;
    const apiKey = process.env.OPENAI_API_KEY || process.env.DEEPINFRA_API_KEY || '';

    // mini-swe-agent uses litellm under the hood. The `openai/` provider
    // prefix tells litellm "OpenAI-compat endpoint" and combined with
    // OPENAI_BASE_URL points it at DeepInfra. drop_params:true (in default
    // .yaml) silently drops fields DeepInfra doesn't recognize.
    const args = [
      '-c', 'default.yaml',
      '--yolo',
      '--cost-limit', String(DEFAULT_COST_LIMIT),
      '--model', model,
      '-t', task,
    ];

    const miniBin = process.env.MINI_SWE_BIN
                 || join(process.env.HOME || '/home/deploy', '.local/bin/mini');

    const proc = spawn(miniBin, args, {
      cwd,
      env: {
        ...process.env,
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: baseUrl,
        // The first-time-config wizard would block stdin forever otherwise.
        // Keep this in lockstep with the .env file at
        // ~/.config/mini-swe-agent/.env on the agents host.
        MSWEA_CONFIGURED: '1',
        MSWEA_COST_TRACKING: 'ignore_errors',
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
      // Closing stdin closed prevents mini's post-completion interactive
      // prompt from hanging the spawn. The agent has already emitted the
      // closing-protocol marker by the time this matters; the prompt is
      // dead weight.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeProcesses.set(jobId, { process: proc, startedAt: Date.now() });

    let stdoutBuf = '';
    let seq = 0;
    const errLogPath = join(agentLogDir, `${jobId}.err.log`);
    const errStream = createWriteStream(errLogPath, { flags: 'a' });
    let stderrTail = '';

    // mini's stdout is line-buffered narrative + tool calls + tool outputs.
    // We don't try to parse incremental tokens (mini doesn't stream them
    // delta-style anyway — it emits chunks per turn). One event per chunk
    // keeps the dashboard timeline live without overcomplicating things.
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      appendEvent({
        job_id: String(jobId),
        seq: seq++,
        event_type: 'assistant',
        event_subtype: 'text',
        payload: {
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
          harness: 'mini-swe-agent',
        },
      }).catch(err => console.error('[mini-swe] appendEvent failed', err.message));
    });

    proc.stderr.on('data', (chunk) => {
      errStream.write(chunk);
      stderrTail += chunk.toString();
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });

    proc.on('close', (code) => {
      activeProcesses.delete(jobId);
      errStream.end();

      const result = synthesizeResult({
        trajPath: TRAJ_PATH,
        exitCode: code,
        agentRole,
      });
      const resultPayload = JSON.stringify(result);

      // Persist the synthetic result event in the same shape Claude's
      // stream-json emits. The dashboard reads `payload.result` as a
      // string-encoded JSON of parseResult shape — this preserves parity.
      appendEvent({
        job_id: String(jobId),
        seq: seq++,
        event_type: 'result',
        event_subtype: result.status === 'done' ? 'success' : 'error',
        payload: {
          type: 'result',
          result: resultPayload,
          exit_code: code,
          harness: 'mini-swe-agent',
          api_calls: result._api_calls,
        },
      }).catch(() => {});
      broadcastDone(String(jobId), { exit_code: code, events: seq, api_calls: result._api_calls });

      // mini's exit code is non-zero when the post-completion shell prompt
      // aborts on closed stdin — the harness itself succeeded. We rely on
      // the trajectory's submission/exit_status to decide success, not on
      // the process exit code. Resolve with the final-text payload that
      // parseResult upstream will then read.
      if (result.status === 'done' || result.status === 'blocked') {
        // Return a stdout-shaped JSON the upstream parseResult can recover.
        // Wrap in code fences so its regex finds the JSON object reliably.
        resolve('```json\n' + resultPayload + '\n```');
      } else {
        reject(new Error(`mini-swe-agent exited with code ${code}, status=${result.status}\nstderr: ${stderrTail.slice(-1000)}`));
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

// Mirror shouldUseGoose's gate semantics so the worker can pick mini-swe
// per-role via DRIVER_<AGENT>=mini, with FORCE_TIER=opus as the kill switch
// and DRIVER_DEFAULT=mini as the global opt-in.
export function shouldUseMiniSwe(agentRole) {
  if (process.env.FORCE_TIER === 'opus') return false;
  const envKey = `DRIVER_${agentRole.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[envKey] === 'mini') return true;
  if (process.env[envKey] === 'claude' || process.env[envKey] === 'goose') return false;
  return process.env.DRIVER_DEFAULT === 'mini';
}
