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
