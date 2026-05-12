#!/usr/bin/env node
// scripts/shelly-pi-loop.js — Shelly-on-Pi runtime.
//
// Pi (`@earendil-works/pi-coding-agent`) has no `claude/channel` concept,
// so we can't run it interactively against telegram-multi the way Claude
// Code does. Instead this loop:
//
//   1. Owns a long-lived telegram-multi child (the SOLE poller for the
//      bot tokens — Telegram returns 409 Conflict if two processes call
//      getUpdates with the same token). Its only job is writing inbound
//      messages to the `shelly_transcript` table.
//   2. Tails `shelly_transcript` (services VPS Postgres) for
//      direction='in' rows newer than our bookmark.
//   3. For each unseen inbound, spawns
//        pi -p "<channel ...>...message body...</channel>"
//           --append-system-prompt $(cat .agents/shelly/SOUL.md)
//           --extension infra/pi-extensions/mcp-bridge
//           --extension infra/pi-extensions/telegram-out
//           --extension infra/pi-extensions/github
//           --extension infra/pi-extensions/loop-guard
//           --provider deepinfra --model Qwen3-Coder-480B-A35B-Instruct
//           --mode json --session shelly/<bot>/<user>
//           --no-context-files --no-skills
//      with PI_MCP_CONFIG=/home/deploy/.mcp-shelly-pi.json — a copy of
//      ~/.mcp.json with the `telegram` entry STRIPPED. We do NOT let the
//      per-pi-run mcp-bridge spawn its own telegram-multi (would be the
//      second poller → 409). Outbound replies go through telegram-out
//      instead, which talks to Telegram's HTTP Bot API directly.
//   4. Pi processes the message, calls MCP tools + telegram-out tools,
//      exits.
//   5. Loop.
//
// One pi run per inbound, but each (bot_label, tg_user_id) shares a
// persistent --session, so the model sees its own previous turns on the
// next inbound. Sessions are JSONL trees auto-created on first reference
// under ~/.pi/agent/sessions/shelly/. Cross-peer talk still goes through
// the `transcript_replay_recent` MCP tool — sessions are per-peer.
//
// Started by infra/shelly-pi.service. The Claude variant
// (infra/shelly.service) and this one are mutually exclusive — running
// both at once means two pollers race on the same bot tokens (409) AND
// both reply to every inbound (double-reply). scripts/shelly-switch.sh
// enforces this; systemd Conflicts= on the unit is the safety net.
//
// Known limitation: infra/shelly-watchdog.* targets shelly.service. After
// flipping to Pi, restart shelly-pi.service manually if it goes deaf.
// Updating the watchdog to be mode-aware is a follow-up.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const PI_BIN = process.env.PI_BIN || join(homedir(), '.npm-global/bin/pi');
const SOUL_PATH = join(REPO_ROOT, '.agents/shelly/SOUL.md');
const PI_EXTENSIONS_ROOT = join(REPO_ROOT, 'infra/pi-extensions');
const PI_PROVIDER = process.env.SHELLY_PI_PROVIDER || 'deepinfra';
const PI_MODEL =
  process.env.SHELLY_PI_MODEL || 'Qwen/Qwen3-Coder-480B-A35B-Instruct';
const POLL_INTERVAL_MS = Number(process.env.SHELLY_POLL_INTERVAL_MS || '2000');

// ---------------------------------------------------------------------------
// Postgres bookmark + inbound polling
// ---------------------------------------------------------------------------

const pool = new pg.Pool({
  host: process.env.PG_HOST || '10.0.0.2',
  port: Number(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'affine',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'agent_memory'
});

async function ensureStateTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shelly_pi_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      last_seen_id BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (id = 1)
    );
  `);
}

async function getLastSeenId() {
  const r = await pool.query(`SELECT last_seen_id FROM shelly_pi_state WHERE id = 1`);
  if (r.rows.length === 0) {
    // First run — bookmark the current max so we don't replay history.
    const max = await pool.query(`SELECT COALESCE(MAX(id), 0) AS m FROM shelly_transcript`);
    const m = Number(max.rows[0].m);
    await pool.query(
      `INSERT INTO shelly_pi_state (id, last_seen_id) VALUES (1, $1)`,
      [m]
    );
    return m;
  }
  return Number(r.rows[0].last_seen_id);
}

async function setLastSeenId(id) {
  await pool.query(
    `UPDATE shelly_pi_state SET last_seen_id = $1, updated_at = NOW() WHERE id = 1`,
    [id]
  );
}

async function fetchNewInbound(sinceId) {
  const r = await pool.query(
    `
    SELECT id, ts, bot_label, bot_username,
           tg_chat_id, tg_user_id, tg_message_id,
           direction, role, source, thread_subject, content,
           attachment_path, attachment_kind, meta
    FROM shelly_transcript
    WHERE id > $1
      AND direction = 'in'
    ORDER BY id ASC
    LIMIT 50
    `,
    [sinceId]
  );
  return r.rows;
}

// ---------------------------------------------------------------------------
// Build the <channel ...> envelope. Mirrors the meta keys telegram-multi
// passes via notifications/claude/channel so SOUL parsing is identical
// across Claude-Shelly and Pi-Shelly.
// ---------------------------------------------------------------------------

function escapeAttr(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildPrompt(row) {
  const meta = row.meta || {};
  const attrs = [
    'source="telegram"',
    `bot_label="${escapeAttr(row.bot_label)}"`,
    `tg_user_id="${escapeAttr(row.tg_user_id)}"`,
    `chat_id="${escapeAttr(row.tg_chat_id)}"`
  ];
  if (row.tg_message_id != null) {
    attrs.push(`message_id="${escapeAttr(row.tg_message_id)}"`);
  }
  if (meta.from_first_name) {
    attrs.push(`first_name="${escapeAttr(meta.from_first_name)}"`);
  }
  if (meta.from_username) {
    attrs.push(`user="${escapeAttr(meta.from_username)}"`);
  }
  attrs.push(`ts="${escapeAttr(row.ts.toISOString())}"`);
  if (row.attachment_path) {
    attrs.push(`image_path="${escapeAttr(row.attachment_path)}"`);
  }
  if (meta.attachment_file_id) {
    attrs.push(`attachment_file_id="${escapeAttr(meta.attachment_file_id)}"`);
  }
  if (row.thread_subject) {
    attrs.push(`thread_subject="${escapeAttr(row.thread_subject)}"`);
  }
  return `<channel ${attrs.join(' ')}>\n${row.content}\n</channel>`;
}

// ---------------------------------------------------------------------------
// Spawn pi for one message
// ---------------------------------------------------------------------------

// Imperative reminder injected at the END of the SOUL when running on Pi.
// Qwen3 generated perfect text replies on the first canary inbound but
// emitted them as plain assistant text and exited without any tool call —
// the user saw nothing. SOUL.md says "Reply with the reply tool" but
// Qwen3 reads it as advisory, not mandatory. Pi 0.74 puts custom-extension
// tool descriptions further down the system prompt than the SOUL itself,
// so the reminder needs to be the LAST thing the model sees before the
// user message. This block is appended to --append-system-prompt.
const PI_REPLY_IMPERATIVE = `

---

# CRITICAL — replying on Telegram (Pi mode)

You are running on the Pi harness. The user is reading TELEGRAM, not your transcript. Plain text in your assistant message is invisible to them — it goes nowhere. **Every visible response MUST be a \`reply\` tool call.**

For each inbound \`<channel ...>\` envelope:

1. Extract \`bot_label\` and \`chat_id\` from the envelope's attributes.
2. Call the \`reply\` tool: \`reply({ bot_label: "<from-envelope>", chat_id: <from-envelope>, text: "<your message>" })\`.
3. The text inside \`reply({...})\` is what reaches the user. The text outside it does not.

If you are confident no response is needed (extremely rare — only for non-actionable system events you are explicitly instructed to ignore), say so by calling \`reply\` with a one-line acknowledgment anyway. **Never end a turn without at least one \`reply\` call when the inbound came from a real user.**

This is mechanical, not optional. If you forget, the user thinks you are dead.
`;

// Pi sessions store turn history as JSONL trees in ~/.pi/agent/sessions/.
// One session per (bot_label, tg_user_id) gives every Telegram peer a
// persistent conversation: pi auto-creates the file on first --session
// reference and resumes it on subsequent runs. Sanitize the id to a flat
// slug so pi can pass it both as a path component and as a partial-id.
//
// Concurrency: pi's tree has an "active leaf" that races on concurrent
// writes to the same id. The loop processes inbounds sequentially per
// peer (the queue is FIFO on shelly_transcript.id and runPiForMessage
// is awaited), so we never race ourselves. Different peers = different
// session ids = naturally safe.
const PI_SESSIONS_ROOT = join(homedir(), '.pi/agent/sessions/shelly');
function safeSlug(v) {
  return String(v ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unknown';
}
function sessionIdFor(row) {
  if (!existsSync(PI_SESSIONS_ROOT)) {
    mkdirSync(PI_SESSIONS_ROOT, { recursive: true });
  }
  return `shelly/${safeSlug(row.bot_label)}/${safeSlug(row.tg_user_id)}`;
}

function runPiForMessage(row) {
  return new Promise((resolve) => {
    const soul = readFileSync(SOUL_PATH, 'utf8') + PI_REPLY_IMPERATIVE;
    const prompt = buildPrompt(row);
    const args = [
      '--provider', PI_PROVIDER,
      '--model', PI_MODEL,
      '--mode', 'json',
      '--session', sessionIdFor(row),
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--extension', join(PI_EXTENSIONS_ROOT, 'mcp-bridge'),
      '--extension', join(PI_EXTENSIONS_ROOT, 'work-items'),
      '--extension', join(PI_EXTENSIONS_ROOT, 'telegram-out'),
      '--extension', join(PI_EXTENSIONS_ROOT, 'github'),
      '--extension', join(PI_EXTENSIONS_ROOT, 'loop-guard'),
      '--append-system-prompt', soul,
      '-p', prompt
    ];
    const proc = spawn(PI_BIN, args, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        // MCP config WITHOUT telegram — telegram-multi is owned by the
        // long-lived child of THIS loop. Per-pi-run bridge connects to
        // every other server (plane, devpanel, affine, playwright,
        // glitchtip, …). Outbound Telegram goes through the telegram-out
        // extension instead, which uses the HTTP Bot API directly.
        PI_MCP_CONFIG: process.env.SHELLY_MCP_CONFIG || join(homedir(), '.mcp-shelly-pi.json'),
        SHELLY_MODE: 'pi',
        INBOUND_TRANSCRIPT_ID: String(row.id),
        // Safety-net context for the telegram-out extension's reply-fallback
        // hook. If Qwen3 emits text but forgets to call reply (chronic
        // failure mode on Qwen3-Coder), the hook synthesizes the call from
        // the assistant text using these values. Without them the safety
        // net silently degrades to no-op.
        INBOUND_BOT_LABEL: row.bot_label || '',
        INBOUND_CHAT_ID: String(row.tg_chat_id || ''),
        INBOUND_MESSAGE_ID: String(row.tg_message_id || '')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', (c) => process.stdout.write(c));
    proc.stderr.on('data', (c) => process.stderr.write(c));
    proc.on('error', (err) => {
      console.error(`[shelly-pi-loop] pi spawn error: ${err.message}`);
      resolve();
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(
          `[shelly-pi-loop] pi exited ${code} on transcript id=${row.id}`
        );
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Long-lived telegram-multi child — sole poller for the bot tokens. Without
// this, no inbound rows ever appear in shelly_transcript and the loop is
// idle forever.
// ---------------------------------------------------------------------------

const TELEGRAM_MULTI_BIN = process.env.TELEGRAM_MULTI_BIN
  || join(homedir(), '.bun/bin/bun');
const TELEGRAM_MULTI_ENTRY = process.env.TELEGRAM_MULTI_ENTRY
  || join(homedir(), '.claude/plugins/telegram-multi/server.ts');

let stopping = false;
let telegramChild = null;
let telegramRespawnTimer = null;

function startTelegramMulti() {
  if (stopping) return;
  if (!existsSync(TELEGRAM_MULTI_ENTRY)) {
    console.error(
      `[shelly-pi-loop] telegram-multi not found at ${TELEGRAM_MULTI_ENTRY} — Pi-Shelly will receive zero inbounds`
    );
    return;
  }
  console.error(`[shelly-pi-loop] starting telegram-multi (${TELEGRAM_MULTI_ENTRY})`);
  telegramChild = spawn(TELEGRAM_MULTI_BIN, [TELEGRAM_MULTI_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // telegram-multi reads the same Postgres for dev_bots + transcripts.
      // STATE_DIR / health snapshot mirror what shelly.service sets so the
      // existing watchdog still finds them (even though it currently
      // restarts the wrong unit — see header comment).
      TELEGRAM_MULTI_HEALTH_DIR: '/home/deploy/logs/telegram-multi',
    },
    // telegram-multi is an MCP stdio server: stdin would be JSON-RPC frames
    // from a host. We are NOT a JSON-RPC host (we read DB rows instead), so
    // we leave stdin open but never write to it. The plugin's grammy
    // pollers + DB writes work without any MCP traffic.
    stdio: ['pipe', 'pipe', 'pipe']
  });
  telegramChild.stdout.on('data', (c) => process.stderr.write(`[tg-multi] ${c}`));
  telegramChild.stderr.on('data', (c) => process.stderr.write(`[tg-multi] ${c}`));
  telegramChild.on('error', (err) => {
    console.error(`[shelly-pi-loop] telegram-multi spawn error: ${err.message}`);
  });
  telegramChild.on('close', (code) => {
    console.error(`[shelly-pi-loop] telegram-multi exited code=${code}`);
    telegramChild = null;
    if (!stopping) {
      // Backoff respawn — same idea as the supervisor in telegram-multi
      // itself, except we're one layer up. 5s is enough to dodge a 409
      // ping-pong if a stale Claude-Shelly is still in its 30s grace.
      telegramRespawnTimer = setTimeout(() => {
        telegramRespawnTimer = null;
        startTelegramMulti();
      }, 5000);
    }
  });
}

function stopTelegramMulti() {
  if (telegramRespawnTimer) {
    clearTimeout(telegramRespawnTimer);
    telegramRespawnTimer = null;
  }
  if (telegramChild) {
    try {
      telegramChild.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

process.on('SIGINT', () => { stopping = true; stopTelegramMulti(); });
process.on('SIGTERM', () => { stopping = true; stopTelegramMulti(); });

async function main() {
  if (!existsSync(PI_BIN)) {
    console.error(`[shelly-pi-loop] PI_BIN not found at ${PI_BIN}`);
    process.exit(1);
  }
  if (!existsSync(SOUL_PATH)) {
    console.error(`[shelly-pi-loop] SOUL.md not found at ${SOUL_PATH}`);
    process.exit(1);
  }

  await ensureStateTable();
  let lastSeenId = await getLastSeenId();
  console.error(`[shelly-pi-loop] starting from shelly_transcript.id=${lastSeenId}`);

  // Bring up the long-lived telegram-multi poller before entering the
  // main loop. If it dies the close handler respawns with backoff.
  startTelegramMulti();

  while (!stopping) {
    try {
      const batch = await fetchNewInbound(lastSeenId);
      for (const row of batch) {
        console.error(
          `[shelly-pi-loop] processing transcript id=${row.id} bot=${row.bot_label} from=${row.tg_user_id}`
        );
        await runPiForMessage(row);
        lastSeenId = row.id;
        await setLastSeenId(lastSeenId);
        if (stopping) break;
      }
    } catch (err) {
      console.error(`[shelly-pi-loop] poll error: ${err.message}`);
    }
    if (stopping) break;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.error('[shelly-pi-loop] shutting down');
  stopTelegramMulti();
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(`[shelly-pi-loop] fatal: ${err?.stack || err}`);
  process.exit(1);
});
