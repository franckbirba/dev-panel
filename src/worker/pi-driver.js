// src/worker/pi-driver.js
//
// Pi (`@earendil-works/pi-coding-agent`) harness driver. Spawns
// `pi --provider <p> --model <m> --mode json -p <prompt>` with SOUL injected
// via `--append-system-prompt`.
//
// MCP access: pi 0.74 ships ZERO built-in MCP support (their docs say so
// explicitly). To give pi-driven agents the same MCP surface Claude Code
// gets, we load the `mcp-bridge` extension (infra/pi-extensions/mcp-bridge),
// which spawns every server in PI_MCP_CONFIG (default ~/.mcp-worker.json on
// the agents host) and re-exposes their tools as `mcp__<server>__<tool>` —
// same naming Claude Code uses, so SOUL prompts and memory writes that
// reference tool names work identically across both harnesses.
//
// Built-in tools (read, edit, bash, grep, write, find, ls) are available
// alongside the MCP-prefixed ones.
//
// Why pi over goose / mini-swe / claude-code:
//
//   Spike on agents host (2026-05-09 18:46):
//     pi --provider deepinfra --model Qwen/Qwen3-Coder-480B-A35B-Instruct
//     -p "read foo.js, add JSDoc above the function" → Qwen3 called
//     pi.read 24× and pi.edit 12×, file edited correctly. ~$0.0001.
//
//     This is the same Qwen3 model that:
//       - goose × Qwen3 burned $18 over a 17-min run, never finished.
//       - Bernstein × qwen-code RED on DEVPA-181 because qwen-code's edit
//         tool false-flagged 70KB JS as binary.
//
//   Pi's built-in tools are robust where qwen-code's were not, AND pi reads
//   the same mcp.json shape Claude Code does — drop-in compatibility.
//
// External contract is identical to mini-swe-driver and goose-driver:
//   - resolves with the final stdout text on exit 0
//   - rejects with stderr tail on non-zero
//   - registers in activeProcesses for cancel_job
//   - writes raw stderr to storage/agent-logs/<job>.err.log
//   - persists translated events through appendEvent (same shape as Claude's
//     stream-json, via pi-stream-shim)
import { spawn, spawnSync } from 'child_process';
import { createWriteStream, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { appendEvent, broadcastDone } from '../server/jobs-events.js';
import { recordHarnessEvent } from './harness-telemetry.js';
import { readSoul, parseResult } from './prompt-builder.js';
import { selectPiModel } from './select-pi-model.js';
import { createPiStreamShim, parsePiLine } from './pi-stream-shim.js';

// H3 fix (docs/architecture/harness-pi.md §4.1): the submit-result
// extension (infra/pi-extensions/submit-result) writes the closing
// envelope to this sentinel file in the job's cwd via a tool call, instead
// of relying on the model to print trailing JSON that parseResult() can
// find. Reading it is the FIRST thing tried on a clean exit — see
// readSubmitResultEnvelope below and its call site in the 'close' handler.
const SUBMIT_RESULT_FILENAME = process.env.PI_SUBMIT_RESULT_FILENAME || '.pi-submit-result.json';

const SUBMIT_RESULT_REQUIRED_TOP = [
  'status', 'summary', 'artifacts', 'handoff', 'memory_writes_count', 'blockers', 'issues_found'
];
const SUBMIT_RESULT_STATUS_ENUM = ['done', 'blocked', 'failed'];

// Validate the sentinel file's contents against the same envelope v1
// contract prompt-builder.js#validate enforces, so a malformed or stale
// file can never masquerade as a real result. Returns an error string, or
// null if valid.
function validateSubmitResultEnvelope(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 'not an object';
  for (const k of SUBMIT_RESULT_REQUIRED_TOP) {
    if (!(k in obj)) return `missing field: ${k}`;
  }
  if (!SUBMIT_RESULT_STATUS_ENUM.includes(obj.status)) return `invalid status: ${obj.status}`;
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) return 'summary must be non-empty string';
  if (typeof obj.artifacts !== 'object' || obj.artifacts === null) return 'artifacts must be object';
  if (typeof obj.handoff !== 'object' || obj.handoff === null) return 'handoff must be object';
  if (typeof obj.memory_writes_count !== 'number') return 'memory_writes_count must be number';
  if (!Array.isArray(obj.blockers)) return 'blockers must be array';
  if (!Array.isArray(obj.issues_found)) return 'issues_found must be array';
  return null;
}

// Read + validate + delete the submit_result sentinel file. Exported for
// unit testing. Deletion is best-effort and happens on every call (valid
// or not) so a stale envelope from an earlier run in the same worktree can
// never leak into the next job — worktrees are reused across job retries
// in some driver configurations, and a leftover sentinel would otherwise
// silently "succeed" a job that never actually called submit_result.
export function readSubmitResultEnvelope(cwd) {
  const path = join(cwd, SUBMIT_RESULT_FILENAME);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, error: 'no sentinel file' };
  } finally {
    try { unlinkSync(path); } catch { /* best-effort cleanup */ }
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `sentinel file is not valid JSON: ${e.message}` };
  }
  const err = validateSubmitResultEnvelope(parsed);
  if (err) return { ok: false, error: `sentinel file failed validation: ${err}` };
  return { ok: true, data: parsed };
}

// Pi can't be told to emit structured JSON via a CLI flag (no
// `--response-format json_schema` on pi 0.74) the way goose can via DeepInfra's
// OpenAI-compat `response.json_schema`. The role's SOUL/prompt asks Qwen3 to
// close with the parseResult-shaped JSON object on its last line, but Qwen3
// drops that ~70% of the time on long runs — observed failure shapes:
//
//   - trailing prose with no JSON at all
//   - hallucinated `<tool_call>...</tool_call>` XML in the answer
//     (caught on job 4771 — last assistant text was literally a partial
//     tool-call snippet with no closing tag, much less the JSON envelope)
//   - JSON cut mid-object by Pi's per-message token cap
//
// The defensive fix below mirrors mini-swe-driver's synthesizeResult: on a
// successful Pi exit, if parseResult fails on the last assistant text, we
// synthesize a parseResult-shaped payload from observable signals (git diff
// in cwd, tool-use count, last assistant text as summary) and resolve with
// that wrapped in fences so prompt-builder's regex finds it.
//
// The verifier in automation.js (verifyAndCommit) still runs `git diff` and
// downgrades to blocked if no real change materialized — so a synthesized
// status=done from a no-op Pi run still won't ship a fake PR.
// Map prompt-builder.parseResult's free-text error into a short stable token
// for harness telemetry (kind=synthesis). Token vocabulary is intentionally
// tiny so dashboard aggregations stay readable.
function classifyPiParseFailure(errMsg) {
  const m = String(errMsg || '');
  if (m.startsWith('no json object found')) return 'no_json_envelope';
  if (m.startsWith('invalid json in fenced block')) return 'invalid_json_in_fence';
  if (m.startsWith('invalid status')) return 'invalid_status_value';
  if (m.includes('missing field')) return 'missing_required_field';
  return 'schema_mismatch';
}

function synthesizePiResult({ cwd, lastAssistantText, toolUseCount, exitCode }) {
  let branch = null;
  let hasChanges = false;
  let commits = [];
  // Parsed from `git status --porcelain` when the agent skipped its closing
  // envelope. Without these, automation.js#verifyAndCommit sees an empty
  // manifest and refuses to commit by design (it won't `git add -A` blindly),
  // so the worktree gets torn down with the agent's edits inside. DEVPA-227.
  let filesModified = [];
  let filesCreated = [];
  try {
    const branchOut = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' });
    if (branchOut.status === 0) branch = branchOut.stdout.trim() || null;
  } catch { /* not a git dir */ }
  try {
    const porcelain = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    if (porcelain.status === 0 && porcelain.stdout.trim()) {
      hasChanges = true;
      // Porcelain format: XY␣<path>, where XY is the two-char status. `??` is
      // untracked (created); anything else with M/A/R/C in either column is
      // modified-or-staged. Renames look like `R  old -> new` — take the new.
      for (const raw of porcelain.stdout.split('\n')) {
        if (raw.length < 4) continue;
        const xy = raw.slice(0, 2);
        const rest = raw.slice(3);
        const path = rest.includes(' -> ') ? rest.split(' -> ').pop() : rest;
        if (xy === '??' || xy[0] === 'A' || xy[1] === 'A') filesCreated.push(path);
        else filesModified.push(path);
      }
    }
  } catch { /* ignore */ }
  try {
    // Commits ahead of the upstream tracking branch (or origin/main fallback).
    const log = spawnSync(
      'git',
      ['log', '--pretty=%H', '-n', '5', '@{upstream}..HEAD'],
      { cwd, encoding: 'utf8' }
    );
    if (log.status === 0 && log.stdout.trim()) {
      commits = log.stdout.trim().split('\n').filter(Boolean);
      hasChanges = true;
    } else {
      const log2 = spawnSync(
        'git',
        ['log', '--pretty=%H', '-n', '5', 'origin/main..HEAD'],
        { cwd, encoding: 'utf8' }
      );
      if (log2.status === 0 && log2.stdout.trim()) {
        commits = log2.stdout.trim().split('\n').filter(Boolean);
        hasChanges = true;
      }
    }
  } catch { /* ignore */ }

  const status = exitCode === 0 && (hasChanges || toolUseCount > 0) ? 'done' : 'blocked';
  const summaryText = (lastAssistantText || '').trim();
  const summarySnippet = summaryText
    ? summaryText.slice(-1200).replace(/\s+/g, ' ').trim()
    : `Pi exited ${exitCode} with ${toolUseCount} tool call(s) — no closing JSON emitted`;

  return {
    status,
    summary: `[pi-synthesized] ${summarySnippet}`,
    artifacts: {
      files_created: filesCreated,
      files_modified: filesModified,
      commits,
      branch,
      tests_passed: false,
      pr_url: null,
    },
    handoff: { next_agent: null, reason: '' },
    memory_writes_count: 0,
    blockers: status === 'blocked'
      ? ['Pi emitted no closing JSON envelope; result synthesized from git state. Review needed.']
      : [],
    issues_found: [],
    _harness: 'pi',
    _synthesized: true,
    _tool_use_count: toolUseCount,
    _exit_code: exitCode,
  };
}

const DEFAULT_PI_BIN = process.env.PI_BIN
  || join(process.env.HOME || '/home/deploy', '.npm-global/bin/pi');

// Pi extensions vendored in this repo. Loaded via --extension flags. Pi
// runs .ts directly via jiti so source changes apply without a build step,
// BUT each extension's own node_modules must exist on disk — the bridge
// pulls in @modelcontextprotocol/sdk, so deploy-agents.sh runs `npm install`
// inside infra/pi-extensions/mcp-bridge/.
//
//   - mcp-bridge: spawn every server in ~/.mcp-worker.json and re-expose
//     their tools as mcp__<server>__<tool>. Without this, pi has no plane
//     / devpanel / pgvector / affine / playwright / glitchtip access at
//     all. THIS IS NOT OPTIONAL for agents that need real work done.
//   - github: structured gh_pr_create / gh_pr_view / etc. tools so the
//     model never has to escape strings through bash (ZENO-339 canary
//     showed Qwen3 burning 24 retries on French apostrophes in `gh pr
//     create`).
//   - bash: bash_exec escape hatch. Pi 0.74 has no shell tool — without
//     this, every role whose prompt says "use bash to ..." silently emits
//     empty content (caught on merge-coordinator job 3029, 2026-05-10).
//     Prefer the structured github / work-items / mcp-bridge tools first;
//     this is the catch-all for git/jq/test commands not covered above.
//   - loop-guard: blocks identical tool calls repeated > N times, accepts
//     a closing-protocol marker for clean termination. Same structural
//     fix mini-swe-agent provides via its yaml.
//   - submit-result (H3): the job-closing envelope becomes a tool call
//     (`submit_result`) instead of trailing JSON text the model has to
//     remember to print. See readSubmitResultEnvelope above and the
//     extension's own index.ts header for the full rationale.
const PI_EXTENSIONS_ROOT = process.env.PI_EXTENSIONS_ROOT
  || join(process.env.PROJECT_ROOT || process.cwd(), 'infra/pi-extensions');
const DEFAULT_PI_EXTENSIONS = [
  join(PI_EXTENSIONS_ROOT, 'mcp-bridge'),
  // Composite extensions — purpose-shaped Pi tools that hide chatty
  // upstream MCP primitives behind one-call verbs. Each composite
  // extension's package.json declares pi.compositeReplaces so mcp-bridge
  // skips the raw equivalents (no two surfaces for the same capability).
  join(PI_EXTENSIONS_ROOT, 'work-items'),
  join(PI_EXTENSIONS_ROOT, 'github'),
  join(PI_EXTENSIONS_ROOT, 'bash'),
  join(PI_EXTENSIONS_ROOT, 'loop-guard'),
  // create-file: safe new-file tool that replaces Pi's built-in `write`
  // (which is hidden via the --tools allowlist on the spawn argv below).
  // Rejects >200 lines and rejects pseudo-JSON-shaped content — the exact
  // Qwen3 failure mode that wasted job 4168 on DEVPA-225. See the
  // extension's index.ts header comment for the incident.
  join(PI_EXTENSIONS_ROOT, 'create-file'),
  join(PI_EXTENSIONS_ROOT, 'submit-result')
];

// Pi built-in tool allowlist (passed via --tools). We keep everything
// EXCEPT `write` — the built-in write is a Claude-tuned whole-file tool
// that weak coders catastrophically fail. Replaced by our `create_file`
// extension above; modifications go through Pi's built-in `edit` (which
// is already Aider-style SEARCH/REPLACE).
const PI_BUILTIN_ALLOWLIST = 'read,edit,grep,find,ls,bash';

// H8 fix (docs/architecture/harness-pi.md §3, ADR-005 H8): `env:
// {...process.env}` on the spawn below used to propagate the agents host's
// ambient NODE_ENV=production straight into every pi job. That's the root
// cause of the 2026-08-11 lockfile drift: a role's SOUL/bash_exec running
// `npm install` inside the worktree silently picked up `--omit=dev`
// (npm's NODE_ENV=production behavior) and dropped devDependencies from
// the lockfile without the model — or anyone — asking for that.
//
// buildPiEnv() is the single place that decides what a pi subprocess sees.
// It is deliberately NOT a strip-everything allowlist: mcp-bridge (the pi
// extension that gives agents MCP access) spawns every configured MCP
// server by copying ITS OWN process.env into the child (see
// infra/pi-extensions/mcp-bridge/index.ts#connectServer) — so PLANE_*,
// ADMIN_API_KEY, PG_*, GITHUB_TOKEN etc. are load-bearing for pi jobs, not
// incidental leakage, and dropping them would break every MCP tool call a
// job makes. What IS safe and correct to strip: variables that only
// exist because pi itself was spawned from an `npm run`-flavored parent
// (npm injects `npm_config_*` / `npm_lifecycle_*` into every child of an
// npm script) and would otherwise silently alter the behavior of any
// npm/node command the model runs via bash_exec inside the job — the same
// class of bug as the NODE_ENV leak, just not yet observed in an incident.
//
// Exported for unit testing (pure function, no process spawn).
const NODE_ENV_POLLUTION_PREFIXES = ['npm_config_', 'npm_lifecycle_', 'npm_package_'];
const NODE_ENV_POLLUTION_KEYS = ['NODE_OPTIONS', 'npm_execpath', 'npm_node_execpath'];

export function buildPiEnv({ baseEnv = process.env, jobId, agentRole, PI_MCP_CONFIG, home } = {}) {
  const HOME = home || baseEnv.HOME || '/home/deploy';
  const env = { ...baseEnv };

  for (const key of Object.keys(env)) {
    if (NODE_ENV_POLLUTION_PREFIXES.some(p => key.startsWith(p)) || NODE_ENV_POLLUTION_KEYS.includes(key)) {
      delete env[key];
    }
  }

  // Force development so devDependencies never get silently omitted by
  // any npm invocation the job makes (npm install, npm ci, npm run test
  // via the .devpanlrc.json commands.test path). Forced, not just
  // defaulted-if-unset, because the leak is specifically the HOST'S
  // ambient production value winning — an operator who genuinely wants a
  // production-flavored job env has no legitimate reason to want it via
  // ambient inheritance rather than an explicit per-job override.
  env.NODE_ENV = 'development';

  // Deterministic git identity so a `git commit` run from inside the job
  // (bash_exec, or a model probing repo state) never fails on "Author
  // identity unknown" when the agents host's ~/.gitconfig has no global
  // user.name/user.email set (or a job runs in an environment — like a
  // container — that doesn't inherit it at all). The worker itself
  // remains the sole real commit authority (automation.js#verifyAndCommit)
  // — this identity exists so pi's OWN sandbox git calls don't crash, not
  // to attribute real commits to "pi agent". Respect an explicit operator
  // override instead of clobbering it.
  if (!env.GIT_AUTHOR_NAME) env.GIT_AUTHOR_NAME = `devpanl-agent-${agentRole || 'unknown'}`;
  if (!env.GIT_AUTHOR_EMAIL) env.GIT_AUTHOR_EMAIL = 'agent@devpanl.dev';
  if (!env.GIT_COMMITTER_NAME) env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
  if (!env.GIT_COMMITTER_EMAIL) env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;

  env.JOB_ID = jobId;
  env.AGENT_ROLE = agentRole;
  if (PI_MCP_CONFIG) env.PI_MCP_CONFIG = PI_MCP_CONFIG;
  env.PATH = [
    join(HOME, '.npm-global/bin'),
    join(HOME, '.bun/bin'),
    join(HOME, '.local/bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin'
  ].join(':');

  return env;
}

// onUsage (H6, docs/architecture/harness-pi.md §4.2, ADR-005 H6): optional
// callback invoked with pi's cumulative usage snapshot ({ input, output,
// totalTokens, ... — whatever pi's provider reports) every time it updates
// during the run — NOT just once at exit. This is the driver's half of
// mid-run budget enforcement: pi already streams usage per assistant
// message (pi-stream-shim.js), so the signal exists, it just wasn't
// reachable before exit. spawnPi does not itself interpret the numbers,
// compare against BUDGET_TOKENS_<ROLE>, or kill the process — that policy
// belongs to the caller (worker/index.js, under active development in a
// parallel worktree for C2/failure-semantics) via `activeProcesses.get
// (jobId).process` or by throwing/killing from inside its own callback.
// Kept as a plain optional param (not a new required field) so existing
// callers that don't pass it keep working unchanged.
export function spawnPi({ jobId, prompt, agentRole, cwd, activeProcesses, agentLogDir, onUsage }) {
  return new Promise((resolve, reject) => {
    const selected = selectPiModel(agentRole);
    if (!selected) {
      return reject(new Error(`pi-driver: no model selected for role "${agentRole}" — set DRIVER_${agentRole.toUpperCase()}_PI_MODEL or FORCE_PI_MODEL`));
    }
    const { provider, model } = selected;
    const soul = readSoul(agentRole);

    // Argv: pi has a clean --provider/--model split, native --mode json,
    // --append-system-prompt for SOUL injection. We disable session+context+
    // skill+template auto-discovery because the worker already injects SOUL
    // and selects skills via prompt-builder; pi's auto-discovery would just
    // duplicate (and possibly conflict with) what we already have.
    //
    // --no-context-files skips Pi's AGENTS.md/CLAUDE.md walk-up; the worker
    // owns the system prompt content via --append-system-prompt + the
    // prompt itself. Letting pi auto-load CLAUDE.md from the worktree's
    // parent dirs would inject project-level instructions the role-specific
    // SOUL deliberately doesn't include.
    const extensionFlags = DEFAULT_PI_EXTENSIONS.flatMap(p => ['--extension', p]);
    const args = [
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
      '-p', prompt
    ];

    // mcp-bridge reads PI_MCP_CONFIG to know which mcp.json to load. Workers
    // must use the worker config (telegram stripped — see deploy-agents.sh)
    // so ephemerals don't spawn parasitic telegram-multi pollers and race
    // Shelly. Shelly's own systemd unit sets PI_MCP_CONFIG=~/.mcp.json (the
    // full config WITH telegram) so Pi-Shelly can reply on Telegram.
    const PI_MCP_CONFIG = process.env.PI_MCP_CONFIG
      || process.env.WORKER_MCP_CONFIG
      || join(process.env.HOME || '/home/deploy', '.mcp-worker.json');

    const proc = spawn(DEFAULT_PI_BIN, args, {
      cwd,
      env: buildPiEnv({ jobId, agentRole, PI_MCP_CONFIG }),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    activeProcesses.set(jobId, { process: proc, startedAt: Date.now() });

    let stdoutBuf = '';
    let lineBuf = '';
    let seq = 0;
    const errLogPath = join(agentLogDir, `${jobId}.err.log`);
    const errStream = createWriteStream(errLogPath, { flags: 'a' });
    let stderrTail = '';

    // Track the last assistant text we saw — we need it to extract the
    // parseResult JSON after agent_end.
    let lastAssistantText = '';
    // Count tool_use events so synthesizePiResult can distinguish "Pi did
    // real work but forgot the closing JSON" from "Pi did nothing".
    let toolUseCount = 0;

    // Hook the shim: each translated event gets persisted through appendEvent.
    const shim = createPiStreamShim({
      onUsage,
      onTranslatedEvent: (event) => {
        // Re-derive type/subtype from the synthesized event the same way
        // stream-parser.classifyEvent would, since appendEvent expects them.
        // We could also import classifyEvent and call it here — but pi-shim
        // already shaped events to match, so a simple inline classification
        // keeps the dependency surface small.
        let event_type = event.type || 'unknown';
        let event_subtype = event.subtype || null;
        if (event_type === 'assistant' || event_type === 'user') {
          const parts = event?.message?.content || [];
          if (event_type === 'assistant' && parts.some(p => p?.type === 'tool_use')) {
            event_type = 'tool_use';
          }
          if (event_type === 'user' && parts.some(p => p?.type === 'tool_result')) {
            event_type = 'tool_result';
            // TODO Gap #1 (2026-05-25): mirror the Claude branch — set
            // event_subtype to 'error' if any tool_result has is_error: true,
            // increment a local toolErrorCount, and emit the synthetic
            // tool_error_threshold event at the configured threshold so the
            // tool_errors_excessive predicate works for Pi runs too.
          }
        }
        // Capture last assistant text for the post-run JSON extraction.
        if (event.type === 'assistant') {
          const textBlock = (event.message?.content || []).find(c => c?.type === 'text');
          if (textBlock?.text) lastAssistantText = textBlock.text;
        }
        if (event_type === 'tool_use') toolUseCount++;
        appendEvent({
          job_id: String(jobId),
          seq: seq++,
          event_type,
          event_subtype,
          payload: event
        }).catch(err => console.error('[pi] appendEvent failed', err.message));
      }
    });

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      lineBuf += text;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        const event = parsePiLine(line);
        if (event) shim.handle(event);
      }
    });

    proc.stderr.on('data', (chunk) => {
      errStream.write(chunk);
      stderrTail += chunk.toString();
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-4000);
    });

    proc.on('close', (code) => {
      activeProcesses.delete(jobId);
      // Flush any trailing line.
      if (lineBuf.trim()) {
        const event = parsePiLine(lineBuf);
        if (event) shim.handle(event);
      }
      errStream.end();

      // If pi exited non-zero before agent_end synthesized a result, push
      // an error event so the dashboard sees something.
      if (code !== 0) {
        shim.emitError(`pi exited with code ${code}\nstderr: ${stderrTail.slice(-1000)}`);
      }

      broadcastDone(String(jobId), {
        exit_code: code,
        events: seq,
        usage: shim.getTotalUsage()
      });

      if (code === 0) {
        // H3 read order (docs/architecture/harness-pi.md §4.1):
        //   1. submit_result sentinel file — the tool-call-driven envelope.
        //      Reliable by construction: getting here means the model made
        //      a structured tool call with a schema-validated payload, not
        //      free text the harness has to guess at.
        //   2. parseResult on the last assistant text — legacy path, still
        //      tried for models/runs that close with the JSON directly
        //      instead of calling submit_result (e.g. Claude, if ever
        //      routed through pi; or partial adoption during rollout).
        //   3. synthesizePiResult — introspects observable git state as a
        //      last resort when neither of the above produced anything.
        // verifyAndCommit in automation.js still gates status=done on a
        // real git diff regardless of which path produced the envelope, so
        // none of these can ship a fake PR on their own.
        const submitted = readSubmitResultEnvelope(cwd);
        if (submitted.ok) {
          resolve(JSON.stringify(submitted.data));
          return;
        }

        const parsed = parseResult(lastAssistantText || '');
        if (parsed.ok) {
          resolve(lastAssistantText);
        } else {
          const synthesized = synthesizePiResult({
            cwd,
            lastAssistantText,
            toolUseCount,
            exitCode: code,
          });
          // Gap #2 telemetry: Pi swallowed the closing JSON envelope and we
          // had to reconstruct one from observable git state. Surface this
          // on the dashboard so the ~30% silent-synthesis rate becomes
          // visible without grepping .err.log files by hand.
          try {
            recordHarnessEvent({
              jobId,
              harness: 'pi',
              kind: 'synthesis',
              reason: classifyPiParseFailure(parsed.error),
              detail: {
                tool_use_count: toolUseCount,
                last_assistant_text_len: (lastAssistantText || '').length,
                synthesized_status: synthesized.status,
                files_modified: synthesized.artifacts?.files_modified?.length || 0,
                files_created: synthesized.artifacts?.files_created?.length || 0,
                commits: synthesized.artifacts?.commits?.length || 0,
              },
            });
          } catch { /* telemetry is best-effort */ }
          resolve('```json\n' + JSON.stringify(synthesized) + '\n```');
        }
      } else {
        reject(new Error(`pi exited with code ${code}\nstderr: ${stderrTail.slice(-1000)}`));
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

// Hard-tier roles never fall through to Pi by default. Reviewer/qa/architect/
// deploy require Claude Opus quality (CLAUDE.md cheap-tier section); routing
// them to Pi-with-anthropic-model fails fast on the agents host because no
// Anthropic key is wired there (`No API key found for anthropic` — caught
// 2026-05-11 on jobs 3134/3135 after DRIVER_DEFAULT=pi swept reviewer in).
// An explicit DRIVER_<HARD_ROLE>=pi still wins (escape hatch for testing on a
// host that does have an Anthropic key wired into Pi).
const HARD_TIER_ROLES = new Set(['reviewer', 'qa', 'architect', 'deploy', 'merge-coordinator']);

// Mirror shouldUseGoose / shouldUseMiniSwe gate semantics. Pi is opt-in via
// DRIVER_<AGENT>=pi or DRIVER_DEFAULT=pi. FORCE_TIER=opus is the kill switch
// (preserves the existing escape hatch — sets every role back to Claude).
export function shouldUsePi(agentRole) {
  if (process.env.FORCE_TIER === 'opus') return false;
  const envKey = `DRIVER_${String(agentRole || '').toUpperCase().replace(/-/g, '_')}`;
  if (process.env[envKey] === 'pi') return true;
  // Per-role overrides for other drivers explicitly veto pi for this role.
  if (['claude', 'mini', 'goose'].includes(process.env[envKey])) return false;
  if (HARD_TIER_ROLES.has(agentRole)) return false;
  return process.env.DRIVER_DEFAULT === 'pi';
}
