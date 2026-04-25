import { pool } from './pg.js';

export async function insertDevBot({ bot_token, bot_username, bot_label, paired_by_tg_user_id }) {
  const { rows } = await pool.query(
    `INSERT INTO dev_bots (bot_token, bot_username, bot_label, paired_by_tg_user_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [bot_token, bot_username, bot_label, paired_by_tg_user_id]
  );
  return rows[0].id;
}

export async function listActiveDevBots() {
  const { rows } = await pool.query(
    `SELECT * FROM dev_bots WHERE status='active' ORDER BY id`
  );
  return rows;
}

export async function listAllDevBots() {
  const { rows } = await pool.query(`SELECT * FROM dev_bots ORDER BY id`);
  return rows;
}

export async function findDevBotByToken(bot_token) {
  const { rows } = await pool.query(
    `SELECT * FROM dev_bots WHERE bot_token=$1`, [bot_token]
  );
  return rows[0] ?? null;
}

export async function findDevBotByLabel(bot_label) {
  const { rows } = await pool.query(
    `SELECT * FROM dev_bots WHERE bot_label=$1`, [bot_label]
  );
  return rows[0] ?? null;
}

export async function findDevBotById(id) {
  const { rows } = await pool.query(`SELECT * FROM dev_bots WHERE id=$1`, [id]);
  return rows[0] ?? null;
}

export async function revokeDevBot(id) {
  await pool.query(`UPDATE dev_bots SET status='revoked' WHERE id=$1`, [id]);
}

export async function updateDevBotOwner(id, { owner_tg_user_id, owner_first_name }) {
  await pool.query(
    `UPDATE dev_bots SET owner_tg_user_id=$1, owner_first_name=$2 WHERE id=$3`,
    [owner_tg_user_id, owner_first_name, id]
  );
}

export async function touchInbound(id) {
  await pool.query(`UPDATE dev_bots SET last_inbound_at=now() WHERE id=$1`, [id]);
}

// Validate a bot token by calling Telegram getMe. Returns { ok, username } or
// { ok:false, error }. Pure HTTP — no DB side effects.
export async function validateTelegramToken(token) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const body = await r.json();
    if (!r.ok || !body.ok) {
      return { ok: false, error: body.description || `HTTP ${r.status}` };
    }
    return { ok: true, username: body.result.username };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Backward-compat: pre-multi-tenant deploys had a single TELEGRAM_BOT_TOKEN
// in env. On first boot of telegram-multi, if no rows exist and env is set,
// seed Franck's row so existing installs migrate transparently.
export async function seedFromEnvIfEmpty(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { seeded: false, reason: 'env missing' };
  const existing = await listAllDevBots();
  if (existing.length > 0) return { seeded: false, reason: 'rows exist' };
  const validation = await validateTelegramToken(token);
  if (!validation.ok) return { seeded: false, reason: validation.error };
  const id = await insertDevBot({
    bot_token: token,
    bot_username: validation.username,
    bot_label: 'franck',
    paired_by_tg_user_id: BigInt(chatId)
  });
  await updateDevBotOwner(id, {
    owner_tg_user_id: BigInt(chatId),
    owner_first_name: 'Franck'
  });
  await addToAllowlist({ tg_user_id: BigInt(chatId), first_name: 'Franck', added_via: 'pair' });
  return { seeded: true, id };
}

// ---------------------------------------------------------------------------
// dev_bot_allowlist — DM allowlist that the telegram-multi plugin enforces.
// Replaces the file-based access.json allowFrom on the agents host so the
// API can grant access at /pair time.
// ---------------------------------------------------------------------------

export async function addToAllowlist({ tg_user_id, first_name = null, added_via = 'manual' }) {
  await pool.query(
    `INSERT INTO dev_bot_allowlist (tg_user_id, first_name, added_via)
     VALUES ($1, $2, $3)
     ON CONFLICT (tg_user_id) DO UPDATE
       SET first_name = COALESCE(EXCLUDED.first_name, dev_bot_allowlist.first_name)`,
    [tg_user_id, first_name, added_via]
  );
}

export async function removeFromAllowlist(tg_user_id) {
  await pool.query(`DELETE FROM dev_bot_allowlist WHERE tg_user_id=$1`, [tg_user_id]);
}

export async function listAllowlist() {
  const { rows } = await pool.query(
    `SELECT tg_user_id, first_name, added_at, added_via
     FROM dev_bot_allowlist ORDER BY added_at`
  );
  return rows;
}
