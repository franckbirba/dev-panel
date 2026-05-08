// src/worker/goose-driver.js
// Phase A-1 goose harness driver. Spawns `goose run --recipe <path>` against
// an OpenAI-compatible provider (DeepInfra → Qwen3-Coder-480B-Turbo).
//
// What changed vs. Phase A-0 (the first canary):
//
//  1. `-i <path>` instead of `-t @<path>`. Goose's -t is text-only — passing
//     `-t @/tmp/foo.txt` makes goose treat the literal "@/tmp/foo.txt" string
//     as the prompt. First canary on 2026-05-08 hit exactly this and the
//     model responded to goose's own welcome banner instead of the work item.
//
//  2. Recipe-based dispatch instead of bare prompt. We render a per-job
//     recipe.yaml that bundles:
//       - instructions (the SOUL + work-item prompt from buildPrompt)
//       - extensions (every MCP server from ~/.mcp-worker.json, minus
//         telegram — workers don't poll Telegram, that's Shelly's job)
//       - settings.goose_provider / goose_model (from env)
//       - response.json_schema enforcing parseResult's required shape
//
//  3. The JSON schema in `response` forces Qwen3 to emit a valid result
//     object via tool-mode/structured-output. Solves the "no json object
//     found in output" + "invalid status: done|blocked|failed" failures
//     where the model parroted the schema enum back as the answer.
//
// External contract is unchanged: resolves with the final stdout text on
// exit 0, rejects with stderr tail on non-zero, registers in
// activeProcesses for cancel_job, writes raw stderr to
// storage/agent-logs/<job>.err.log, persists synthetic events through
// appendEvent so the dashboard timeline still renders.
import { spawn } from 'child_process';
import { createWriteStream, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
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

// MCP servers we never want goose to mount in a worker. Telegram is the
// canonical case — only Shelly's tmux session may poll the bot tokens, a
// second poller triggers Telegram 409 Conflict storms (see CLAUDE.md "Who
// polls the Telegram bot token"). The Claude path already excludes telegram
// via --strict-mcp-config + --mcp-config /home/deploy/.mcp-worker.json (the
// worker file deliberately omits telegram); but the file we read here is
// the same one — keep the explicit denylist as belt-and-braces for any
// future config drift.
const MCP_DENYLIST = new Set(['telegram']);

// JSON schema enforced server-side via the recipe's `response.json_schema`.
// Mirrors src/worker/prompt-builder.js:validate() — keep these in sync.
// Forcing structured output via Qwen3's JSON-mode is what fixes the parse
// failures we hit on the first canary.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    status:               { type: 'string', enum: ['done', 'blocked', 'failed'] },
    summary:              { type: 'string', minLength: 1 },
    artifacts: {
      type: 'object',
      properties: {
        files_created:    { type: 'array', items: { type: 'string' } },
        files_modified:   { type: 'array', items: { type: 'string' } },
        commits:          { type: 'array', items: { type: 'string' } },
        branch:           { type: ['string', 'null'] },
        tests_passed:     { type: 'boolean' },
        pr_url:           { type: ['string', 'null'] },
      },
    },
    handoff: {
      type: 'object',
      properties: {
        next_agent:       { type: ['string', 'null'] },
        reason:           { type: 'string' },
      },
    },
    memory_writes_count:  { type: 'number' },
    blockers:             { type: 'array' },
    issues_found:         { type: 'array' },
  },
  required: ['status', 'summary', 'artifacts', 'handoff', 'memory_writes_count', 'blockers', 'issues_found'],
};

function envForGoose() {
  return {
    GOOSE_PROVIDER:        process.env.GOOSE_PROVIDER || DEFAULT_PROVIDER,
    GOOSE_BASE_URL:        process.env.GOOSE_BASE_URL || DEFAULT_BASE_URL,
    GOOSE_MODEL:           process.env.GOOSE_MODEL    || DEFAULT_MODEL,
    OPENAI_BASE_URL:       process.env.GOOSE_BASE_URL || DEFAULT_BASE_URL,
    OPENAI_API_KEY:        process.env.OPENAI_API_KEY || process.env.DEEPINFRA_API_KEY || '',
    GOOSE_MODE:            process.env.GOOSE_MODE     || 'auto',
    // Force file-based secret storage so we can seed extension secrets via
    // ~/.config/goose/secrets.yaml. Without this, goose looks up env_keys in
    // the system keyring and the recipe fails with "Configuration value not
    // found: X" — the model gets goose with zero MCP tools available, then
    // wanders. See first canary 2026-05-08.
    GOOSE_DISABLE_KEYRING: '1',
  };
}

// Goose stores extension secrets in ~/.config/goose/secrets.yaml as flat
// top-level YAML key/value pairs (NOT nested by extension name). The recipe's
// `env_keys` declares which keys an extension needs; goose looks them up
// in this file. We render the file fresh at each spawn from process.env.
//
// Idempotent: same content on repeat calls. Cheap: ~30 keys, ~1 KB. Per-job
// regeneration would need XDG_CONFIG_HOME isolation which adds plumbing for
// no real benefit (goose is one process per job, no concurrent secret writes).
function writeGooseSecrets(neededKeys) {
  const home = process.env.HOME || homedir();
  const dir = join(home, '.config', 'goose');
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  const path = join(dir, 'secrets.yaml');
  const lines = [];
  // Carry OPENAI_API_KEY explicitly — that's the model-provider key, separate
  // from extension secrets but lives in the same file.
  const openaiKey = process.env.OPENAI_API_KEY || process.env.DEEPINFRA_API_KEY || '';
  if (openaiKey) lines.push(`OPENAI_API_KEY: ${yamlEscape(openaiKey)}`);
  for (const k of neededKeys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length > 0) {
      lines.push(`${k}: ${yamlEscape(v)}`);
    }
  }
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
}

function yamlEscape(v) {
  // Anything with quotes, colons, leading/trailing whitespace, or yaml
  // special chars needs quoting. Simple safe rule: always double-quote
  // and escape backslashes + double-quotes.
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function workerMcpConfigPath() {
  return process.env.WORKER_MCP_CONFIG
      || join(homedir(), '.mcp-worker.json');
}

// Render Claude's `~/.mcp-worker.json` mcpServers map into goose recipe
// `extensions` array. Returns { extensions, env_passthrough } where:
//   - extensions: array conforming to goose's recipe schema
//   - env_passthrough: object of env vars the spawned goose process needs
//     in its environment so each stdio MCP child inherits them. We pass
//     concrete values via the `envs` map per-extension, but goose still
//     wants the keys declared in `env_keys` to be visible in process env.
function renderExtensions(mcpConfigPath) {
  if (!existsSync(mcpConfigPath)) {
    return { extensions: [], env_passthrough: {} };
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
  } catch (e) {
    console.warn(`[goose] failed to parse ${mcpConfigPath}: ${e.message}`);
    return { extensions: [], env_passthrough: {} };
  }
  const servers = cfg?.mcpServers || {};
  const extensions = [];
  const env_passthrough = {};
  for (const [name, spec] of Object.entries(servers)) {
    if (MCP_DENYLIST.has(name)) continue;
    if (!spec?.command) continue;
    const env_keys = Object.keys(spec.env || {});
    extensions.push({
      type: 'stdio',
      name,
      cmd: spec.command,
      args: spec.args || [],
      env_keys,
      timeout: 300,
      description: `MCP extension: ${name}`,
    });
    // Goose recipes don't read `envs` (only env_keys → secrets.yaml). But we
    // still bubble values into the goose process env so the stdio MCP child
    // sees them at exec time — some MCPs read process.env at module init
    // before goose has a chance to inject anything via the launcher.
    for (const [k, v] of Object.entries(spec.env || {})) {
      if (typeof v === 'string') env_passthrough[k] = v;
    }
  }
  return { extensions, env_passthrough };
}

function buildRecipe({ prompt, extensions, model, provider }) {
  // The `developer` builtin extension provides shell/text_editor/file tools
  // — the basic primitives the model needs to read and edit files in the
  // worktree. Without it, listing only the stdio MCP extensions leaves the
  // model with no way to access the filesystem (canary #3, 2026-05-08:
  // "Unable to access the project files due to environment configuration
  // issues" — the model had MCP tools but no shell).
  const allExtensions = [
    { type: 'builtin', name: 'developer', timeout: 300 },
    ...extensions,
  ];
  return {
    version: '1.0.0',
    title: 'devpanl agent run',
    description: 'Agent dispatch — prompt + MCP extensions + structured output',
    instructions: prompt,
    prompt: 'Begin. End your response with a single JSON object matching the response schema.',
    extensions: allExtensions,
    settings: {
      goose_provider: provider,
      goose_model: model,
      max_turns: 60,
    },
    response: {
      json_schema: RESPONSE_SCHEMA,
    },
  };
}

// Naive YAML-ish encoder for the recipe shape — JSON is valid YAML 1.2, so
// we sidestep adding a yaml dep by writing the recipe as JSON. goose accepts
// recipes in either YAML or JSON (recipe-reference.md says so explicitly).
function writeRecipe(recipe, outPath) {
  writeFileSync(outPath, JSON.stringify(recipe, null, 2), 'utf8');
}

export function spawnGoose({ jobId, prompt, agentRole, cwd, activeProcesses, agentLogDir }) {
  return new Promise((resolve, reject) => {
    const recipeDir = join(tmpdir(), 'goose-recipes');
    try { mkdirSync(recipeDir, { recursive: true }); } catch { /* exists */ }
    const recipePath = join(recipeDir, `${jobId}-${randomUUID()}.json`);

    const { extensions, env_passthrough } = renderExtensions(workerMcpConfigPath());
    const goose = envForGoose();
    const recipe = buildRecipe({
      prompt,
      extensions,
      model: goose.GOOSE_MODEL,
      provider: goose.GOOSE_PROVIDER,
    });
    writeRecipe(recipe, recipePath);

    // Seed ~/.config/goose/secrets.yaml with every key any extension needs.
    // Goose reads from this file (with GOOSE_DISABLE_KEYRING=1) and not from
    // process.env — that's why the first canary's MCP graph never started.
    const neededKeys = new Set();
    for (const ext of extensions) {
      for (const k of ext.env_keys || []) neededKeys.add(k);
    }
    writeGooseSecrets([...neededKeys]);

    const proc = spawn('goose', [
      'run',
      '--no-session',
      '--recipe', recipePath,
    ], {
      cwd,
      env: {
        ...process.env,
        ...goose,
        ...env_passthrough,
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
