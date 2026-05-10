// src/server/studio-members.js
// Studio-wide identity + capability + destination — one row per human.
// Spec: docs/superpowers/specs/2026-05-09-agent-interactivity-v2-design.md (Step 3)
//
// Single source of truth for "who is this Telegram user, what can they do,
// where do I message them." Replaces three ad-hoc concepts:
//   - dev_bot_allowlist (kept for pairing, not authz).
//   - Hardcoded tg_user_id=5663177530 Franck checks.
//   - Plane-membership-as-authz misuse.
//
// Used by HITL routing (Step 5), authz on tool_approval, and the adapter
// whitelist filter in telegram-multi (Step 4).

import { pool } from './pg.js';

function normalizeRow(row) {
  if (!row) return null;
  return {
    ...row,
    tg_user_id: row.tg_user_id == null ? null : String(row.tg_user_id),
    default_dm_chat_id: row.default_dm_chat_id == null ? null : String(row.default_dm_chat_id),
  };
}

export async function upsertMember({
  tg_user_id,
  display_name,
  bot_label = null,
  projects = [],
  roles = [],
  can_deploy = false,
  can_approve_merge = false,
  default_dm_chat_id,
}) {
  if (tg_user_id == null) throw new Error('tg_user_id required');
  if (!display_name) throw new Error('display_name required');
  if (default_dm_chat_id == null) {
    // Sensible default: DM the user direct — same value as tg_user_id.
    default_dm_chat_id = tg_user_id;
  }
  const { rows } = await pool.query(
    `INSERT INTO studio_members
       (tg_user_id, display_name, bot_label, projects, roles,
        can_deploy, can_approve_merge, default_dm_chat_id)
     VALUES ($1, $2, $3, $4::text[], $5::text[], $6, $7, $8)
     ON CONFLICT (tg_user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           bot_label = EXCLUDED.bot_label,
           projects = EXCLUDED.projects,
           roles = EXCLUDED.roles,
           can_deploy = EXCLUDED.can_deploy,
           can_approve_merge = EXCLUDED.can_approve_merge,
           default_dm_chat_id = EXCLUDED.default_dm_chat_id,
           updated_at = now()
     RETURNING *`,
    [
      String(tg_user_id), display_name, bot_label, projects, roles,
      can_deploy, can_approve_merge, String(default_dm_chat_id),
    ]
  );
  return normalizeRow(rows[0]);
}

export async function getByTgUserId(tg_user_id) {
  if (tg_user_id == null) return null;
  const { rows } = await pool.query(
    `SELECT * FROM studio_members WHERE tg_user_id = $1`,
    [String(tg_user_id)]
  );
  return normalizeRow(rows[0] || null);
}

export async function getByBotLabel(bot_label) {
  if (!bot_label) return null;
  const { rows } = await pool.query(
    `SELECT * FROM studio_members WHERE bot_label = $1 LIMIT 1`,
    [bot_label]
  );
  return normalizeRow(rows[0] || null);
}

export async function listMembers() {
  const { rows } = await pool.query(
    `SELECT * FROM studio_members ORDER BY display_name ASC`
  );
  return rows.map(normalizeRow);
}

export async function listDeployers() {
  const { rows } = await pool.query(
    `SELECT * FROM studio_members WHERE can_deploy = TRUE ORDER BY display_name ASC`
  );
  return rows.map(normalizeRow);
}

export async function listMembersOnProject(project_slug) {
  if (!project_slug) return [];
  const { rows } = await pool.query(
    `SELECT * FROM studio_members
      WHERE $1 = ANY(projects)
      ORDER BY display_name ASC`,
    [project_slug]
  );
  return rows.map(normalizeRow);
}

export async function removeMember(tg_user_id) {
  if (tg_user_id == null) return false;
  const { rowCount } = await pool.query(
    `DELETE FROM studio_members WHERE tg_user_id = $1`,
    [String(tg_user_id)]
  );
  return rowCount > 0;
}

// isAuthorized — single capability gate. Capability is one of:
//   'deploy'        → can_deploy
//   'approve_merge' → can_approve_merge
// Returns false for unknown users or unknown capabilities (fail-closed).
export async function isAuthorized(tg_user_id, capability) {
  const member = await getByTgUserId(tg_user_id);
  if (!member) return false;
  if (capability === 'deploy') return Boolean(member.can_deploy);
  if (capability === 'approve_merge') return Boolean(member.can_approve_merge);
  return false;
}
