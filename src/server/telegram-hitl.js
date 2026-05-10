// src/server/telegram-hitl.js
// Telegram bridge for the HITL inbox primitive.
// Spec: docs/superpowers/specs/2026-05-09-agent-interactivity-v2-design.md (Step 2)
//
// Outbound: when await_human writes a question to job_inbox, we send Telegram
// a message with one of three shapes:
//   - clarification + options[] → inline keyboard, callback_data="inbox:<job_id>:<seq>:<idx>"
//   - clarification + no options → ForceReply (record tg_message_id for lookup)
//   - tool_approval → inline keyboard with [Allow, Deny], callback_data="inbox:<job_id>:<seq>:allow|deny"
//
// Inbound: handled in plugins/telegram-multi/server.ts. The plugin parses
// callback_query / reply_to_message and POSTs to /api/jobs/:job_id/inbox/reply
// with X-Admin-Key auth. This module exposes the parsing + resolution
// helpers the plugin uses.
//
// Routing (Step 2 simplification): single TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
// (Franck's bot). Step 3 introduces studio_members for per-dev routing.

import { pool } from './pg.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function getToken() {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

function getChatId() {
  return process.env.TELEGRAM_CHAT_ID || null;
}

async function tgCall(method, body) {
  const token = getToken();
  if (!token) return { ok: false, skipped: true, reason: 'no_token' };
  const r = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await r.json(); } catch { /* non-JSON */ }
  return { ok: r.ok, status: r.status, payload };
}

function buildInlineKeyboard(buttons) {
  return {
    inline_keyboard: buttons.map(btn => [{ text: btn.text, callback_data: btn.callback_data }]),
  };
}

function buildForceReply() {
  return { force_reply: true, selective: true };
}

function formatPromptText({ kind, content }) {
  if (kind === 'tool_approval') {
    let txt = `🤖 Agent veut utiliser un outil — confirmer?\n\n`;
    txt += content.prompt ? `${content.prompt}\n\n` : '';
    if (content.tool) txt += `Tool: ${content.tool}\n`;
    if (content.args) {
      const args = typeof content.args === 'string'
        ? content.args
        : JSON.stringify(content.args, null, 2);
      txt += `Args:\n${args.length > 600 ? args.slice(0, 600) + '\n…(tronqué)' : args}`;
    }
    return txt;
  }
  return `🤖 Agent demande:\n\n${content.prompt || '(question vide)'}`;
}

// === Outbound ===============================================================

export async function sendInboxQuestion({ job_id, inbox_seq, kind, content }) {
  if (!getToken()) return { skipped: true, reason: 'no_token' };
  const chat_id = getChatId();
  if (!chat_id) return { skipped: true, reason: 'no_chat_id' };

  const text = formatPromptText({ kind, content });
  let reply_markup;
  let needsPendingRow = false;

  if (kind === 'tool_approval') {
    reply_markup = buildInlineKeyboard([
      { text: '✅ Allow', callback_data: `inbox:${job_id}:${inbox_seq}:allow` },
      { text: '❌ Deny', callback_data: `inbox:${job_id}:${inbox_seq}:deny` },
    ]);
  } else if (Array.isArray(content?.options) && content.options.length > 0) {
    reply_markup = buildInlineKeyboard(
      content.options.map((opt, idx) => ({
        text: String(opt).slice(0, 64),
        callback_data: `inbox:${job_id}:${inbox_seq}:${idx}`,
      }))
    );
  } else {
    reply_markup = buildForceReply();
    needsPendingRow = true;
  }

  const result = await tgCall('sendMessage', { chat_id, text, reply_markup });
  if (!result.ok || !result.payload?.ok) {
    return { ok: false, error: result.payload?.description || `status ${result.status}` };
  }

  const message_id = result.payload.result?.message_id;
  const tg_chat_id = result.payload.result?.chat?.id;

  if (needsPendingRow && message_id != null && tg_chat_id != null) {
    await recordPendingReply({
      tg_chat_id: BigInt(tg_chat_id),
      tg_message_id: BigInt(message_id),
      job_id,
      inbox_seq,
    });
  }

  return { ok: true, message_id, chat_id: tg_chat_id };
}

export async function confirmReply({ tg_chat_id, tg_message_id, original_prompt, answer, source }) {
  if (!getToken()) return { skipped: true, reason: 'no_token' };
  const text = original_prompt
    ? `🤖 Agent demandait:\n\n${original_prompt}\n\n→ ${answer}  _(${source || 'human'})_`
    : `→ ${answer}  _(${source || 'human'})_`;
  return tgCall('editMessageText', {
    chat_id: String(tg_chat_id),
    message_id: Number(tg_message_id),
    text,
    parse_mode: 'Markdown',
  });
}

export async function answerCallback({ callback_query_id, text }) {
  if (!getToken()) return { skipped: true, reason: 'no_token' };
  return tgCall('answerCallbackQuery', {
    callback_query_id,
    text: text || '✓',
  });
}

// === Pending replies (ForceReply lookup table) ==============================

export async function recordPendingReply({ tg_chat_id, tg_message_id, job_id, inbox_seq, bot_label = 'franck' }) {
  await pool.query(
    `INSERT INTO telegram_pending_replies
       (tg_chat_id, tg_message_id, job_id, inbox_seq, bot_label)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tg_chat_id, tg_message_id) DO UPDATE
       SET job_id = EXCLUDED.job_id,
           inbox_seq = EXCLUDED.inbox_seq,
           bot_label = EXCLUDED.bot_label,
           created_at = now()`,
    [String(tg_chat_id), String(tg_message_id), job_id, inbox_seq, bot_label]
  );
}

export async function resolveForceReply({ tg_chat_id, tg_message_id }) {
  const { rows } = await pool.query(
    `SELECT job_id, inbox_seq FROM telegram_pending_replies
      WHERE tg_chat_id = $1 AND tg_message_id = $2`,
    [String(tg_chat_id), String(tg_message_id)]
  );
  return rows[0] || null;
}

export async function clearPendingReply({ tg_chat_id, tg_message_id }) {
  await pool.query(
    `DELETE FROM telegram_pending_replies
      WHERE tg_chat_id = $1 AND tg_message_id = $2`,
    [String(tg_chat_id), String(tg_message_id)]
  );
}

// Periodic sweep — call this from a cron / interval to clear orphaned rows
// older than 24h (paused jobs that never got answered).
export async function sweepStalePendingReplies({ olderThanHours = 24 } = {}) {
  const { rowCount } = await pool.query(
    `DELETE FROM telegram_pending_replies
      WHERE created_at < now() - $1::interval`,
    [`${olderThanHours} hours`]
  );
  return { deleted: rowCount };
}

// === Callback parsing (used by plugin's callback_query handler) =============

const INBOX_CB_RE = /^inbox:([^:]+):(\d+):(.+)$/;

export function parseInboxCallback(callback_data) {
  if (typeof callback_data !== 'string') return null;
  const m = callback_data.match(INBOX_CB_RE);
  if (!m) return null;
  const [, job_id, seqStr, tail] = m;
  const inbox_seq = parseInt(seqStr, 10);
  if (!Number.isFinite(inbox_seq)) return null;
  if (tail === 'allow' || tail === 'deny') {
    return { job_id, inbox_seq, idx: null, kind: tail };
  }
  const idx = parseInt(tail, 10);
  if (!Number.isFinite(idx)) return null;
  return { job_id, inbox_seq, idx, kind: 'option' };
}

export function resolveOption(question_content, idx) {
  const options = question_content?.options;
  if (!Array.isArray(options)) return null;
  if (idx < 0 || idx >= options.length) return null;
  return String(options[idx]);
}
