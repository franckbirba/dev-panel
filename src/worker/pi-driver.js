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
import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { appendEvent, broadcastDone } from '../server/jobs-events.js';
import { readSoul } from './prompt-builder.js';
import { selectPiModel } from './select-pi-model.js';
import { createPiStreamShim, parsePiLine } from './pi-stream-shim.js';

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
  join(PI_EXTENSIONS_ROOT, 'loop-guard')
];

export function spawnPi({ jobId, prompt, agentRole, cwd, activeProcesses, agentLogDir }) {
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
      env: {
        ...process.env,
        JOB_ID: jobId,
        AGENT_ROLE: agentRole,
        PI_MCP_CONFIG,
        PATH: [
          join(process.env.HOME || '/home/deploy', '.npm-global/bin'),
          join(process.env.HOME || '/home/deploy', '.bun/bin'),
          join(process.env.HOME || '/home/deploy', '.local/bin'),
          '/usr/local/bin',
          '/usr/bin',
          '/bin'
        ].join(':')
      },
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

    // Hook the shim: each translated event gets persisted through appendEvent.
    const shim = createPiStreamShim({
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
          }
        }
        // Capture last assistant text for the post-run JSON extraction.
        if (event.type === 'assistant') {
          const textBlock = (event.message?.content || []).find(c => c?.type === 'text');
          if (textBlock?.text) lastAssistantText = textBlock.text;
        }
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
        // Resolve with the last assistant text — upstream parseResult will
        // recover the trailing JSON object the role's SOUL instructed it to
        // emit, same contract as the Claude path.
        resolve(lastAssistantText || stdoutBuf);
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

// Mirror shouldUseGoose / shouldUseMiniSwe gate semantics. Pi is opt-in via
// DRIVER_<AGENT>=pi or DRIVER_DEFAULT=pi. FORCE_TIER=opus is the kill switch
// (preserves the existing escape hatch — sets every role back to Claude).
export function shouldUsePi(agentRole) {
  if (process.env.FORCE_TIER === 'opus') return false;
  const envKey = `DRIVER_${String(agentRole || '').toUpperCase().replace(/-/g, '_')}`;
  if (process.env[envKey] === 'pi') return true;
  // Per-role overrides for other drivers explicitly veto pi for this role.
  if (['claude', 'mini', 'goose'].includes(process.env[envKey])) return false;
  return process.env.DRIVER_DEFAULT === 'pi';
}
