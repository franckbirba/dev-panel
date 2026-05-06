// Handler logic for the 4 dev-bots MCP tools (pair_dev_bot, list_dev_bots,
// revoke_dev_bot, list_dev_bot_allowlist). Mirrors the HTTP routes in
// src/server/routes-dev-bots.js so Shelly can pair a new dev's Telegram bot
// from a /pair DM without going through fetch (which her hard rules forbid).
//
// Errors carry a `.code` so the MCP wrapper can render the right
// 400-/409-equivalent without sniffing the message.

import {
  insertDevBot,
  listActiveDevBots,
  listAllDevBots,
  findDevBotById,
  revokeDevBot,
  validateTelegramToken,
  addToAllowlist,
  listAllowlist
} from '../server/dev-bots.js';

// BigInt columns must be stringified — the MCP transport encodes content via
// JSON.stringify and would otherwise throw "Do not know how to serialize a
// BigInt".
export function serializeDevBot(row) {
  if (!row) return null;
  return {
    ...row,
    owner_tg_user_id: row.owner_tg_user_id != null ? String(row.owner_tg_user_id) : null,
    paired_by_tg_user_id: String(row.paired_by_tg_user_id)
  };
}

export async function pairDevBot({ token, label, paired_by_tg_user_id }) {
  if (!token || !label || paired_by_tg_user_id == null || paired_by_tg_user_id === '') {
    const err = new Error('token, label, paired_by_tg_user_id required');
    err.code = 'invalid_args';
    throw err;
  }
  const validation = await validateTelegramToken(token);
  if (!validation.ok) {
    const err = new Error(validation.error);
    err.code = 'invalid_token';
    throw err;
  }
  let id;
  try {
    id = await insertDevBot({
      bot_token: token,
      bot_username: validation.username,
      bot_label: label,
      paired_by_tg_user_id: BigInt(paired_by_tg_user_id)
    });
  } catch (err) {
    if (/duplicate|unique/i.test(err.message)) {
      const e = new Error('bot already paired');
      e.code = 'duplicate';
      throw e;
    }
    throw err;
  }
  await addToAllowlist({
    tg_user_id: BigInt(paired_by_tg_user_id),
    added_via: 'pair'
  });
  return serializeDevBot(await findDevBotById(id));
}

export async function listDevBots({ status } = {}) {
  const rows = status === 'active' ? await listActiveDevBots() : await listAllDevBots();
  return rows.map(serializeDevBot);
}

export async function revokeDevBotById({ id }) {
  const numeric = typeof id === 'number' ? id : parseInt(id, 10);
  if (!Number.isFinite(numeric)) {
    const err = new Error(`invalid id: ${id}`);
    err.code = 'invalid_args';
    throw err;
  }
  await revokeDevBot(numeric);
  return { ok: true, id: numeric };
}

export async function listDevBotAllowlist() {
  const rows = await listAllowlist();
  return rows.map(r => ({ ...r, tg_user_id: String(r.tg_user_id) }));
}
