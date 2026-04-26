// src/server/team.js
// Team roster + label routing per project. Tables team_members and
// team_routing live in shared Postgres (migration 006). Reads denormalize the
// dev_bot fields the callers actually need (label, username, tg_user_id) so
// the route handler / MCP / Shelly never have to JOIN themselves.

import { pool } from './pg.js';

export async function addMember({ project_id, display_name, dev_bot_id }) {
  // Pull tg_user_id from dev_bots so callers don't have to.
  const { rows: bots } = await pool.query(
    `SELECT owner_tg_user_id FROM dev_bots WHERE id = $1`, [dev_bot_id]
  );
  if (!bots[0]) throw new Error(`dev_bot ${dev_bot_id} not found`);
  const tg = bots[0].owner_tg_user_id;
  const { rows } = await pool.query(
    `INSERT INTO team_members (project_id, display_name, dev_bot_id, tg_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, display_name, dev_bot_id, tg_user_id`,
    [project_id, display_name, dev_bot_id, tg]
  );
  const r = rows[0];
  return {
    id: r.id,
    project_id: r.project_id,
    display_name: r.display_name,
    dev_bot_id: r.dev_bot_id,
    tg_user_id: r.tg_user_id != null ? String(r.tg_user_id) : null
  };
}

export async function listMembers(project_id) {
  const { rows } = await pool.query(
    `SELECT m.id, m.project_id, m.display_name, m.dev_bot_id, m.tg_user_id,
            b.bot_label, b.bot_username, b.owner_first_name
       FROM team_members m
       LEFT JOIN dev_bots b ON b.id = m.dev_bot_id
      WHERE m.project_id = $1
      ORDER BY m.id`,
    [project_id]
  );
  return rows.map(r => ({
    id: r.id,
    project_id: r.project_id,
    display_name: r.display_name,
    dev_bot_id: r.dev_bot_id,
    tg_user_id: r.tg_user_id != null ? String(r.tg_user_id) : null,
    dev_bot: r.dev_bot_id ? {
      id: r.dev_bot_id,
      label: r.bot_label,
      username: r.bot_username,
      owner_first_name: r.owner_first_name
    } : null
  }));
}

export async function findMember(member_id) {
  const { rows } = await pool.query(
    `SELECT m.id, m.project_id, m.display_name, m.dev_bot_id, m.tg_user_id,
            b.bot_label, b.bot_username, b.owner_first_name
       FROM team_members m
       LEFT JOIN dev_bots b ON b.id = m.dev_bot_id
      WHERE m.id = $1`,
    [member_id]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    project_id: r.project_id,
    display_name: r.display_name,
    dev_bot_id: r.dev_bot_id,
    tg_user_id: r.tg_user_id != null ? String(r.tg_user_id) : null,
    dev_bot: r.dev_bot_id ? {
      id: r.dev_bot_id,
      label: r.bot_label,
      username: r.bot_username,
      owner_first_name: r.owner_first_name
    } : null
  };
}

export async function updateMember(id, { display_name, dev_bot_id }) {
  // If dev_bot_id changes, refresh tg_user_id.
  let newTg = null;
  if (dev_bot_id != null) {
    const { rows: bots } = await pool.query(
      `SELECT owner_tg_user_id FROM dev_bots WHERE id = $1`, [dev_bot_id]
    );
    if (!bots[0]) throw new Error(`dev_bot ${dev_bot_id} not found`);
    newTg = bots[0].owner_tg_user_id;
  }
  const sets = [];
  const params = [];
  if (display_name != null) { params.push(display_name); sets.push(`display_name = $${params.length}`); }
  if (dev_bot_id != null)   { params.push(dev_bot_id);   sets.push(`dev_bot_id = $${params.length}`);
                              params.push(newTg);        sets.push(`tg_user_id = $${params.length}`); }
  if (sets.length === 0) return findMember(id);
  params.push(id);
  await pool.query(
    `UPDATE team_members SET ${sets.join(', ')} WHERE id = $${params.length}`,
    params
  );
  return findMember(id);
}

export async function deleteMember(id) {
  // ON DELETE CASCADE clears team_routing rows.
  await pool.query(`DELETE FROM team_members WHERE id = $1`, [id]);
}

export async function setRoutingForProject(project_id, rules) {
  // Full-replace, transactional. Validates member ownership of project.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (rules.length > 0) {
      const ids = rules.map(r => r.member_id);
      const { rows: owned } = await client.query(
        `SELECT id FROM team_members WHERE project_id = $1 AND id = ANY($2::int[])`,
        [project_id, ids]
      );
      if (owned.length !== new Set(ids).size) {
        throw new Error('one or more member_id values do not belong to this project');
      }
    }
    await client.query(`DELETE FROM team_routing WHERE project_id = $1`, [project_id]);
    for (const r of rules) {
      await client.query(
        `INSERT INTO team_routing (project_id, label, member_id) VALUES ($1, $2, $3)`,
        [project_id, r.label, r.member_id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listRoutingForProject(project_id) {
  const { rows } = await pool.query(
    `SELECT r.label, r.member_id, m.display_name AS member_name
       FROM team_routing r
       JOIN team_members m ON m.id = r.member_id
      WHERE r.project_id = $1
      ORDER BY r.label`,
    [project_id]
  );
  return rows;
}

export async function listLabelsForProject(project_id) {
  const rows = await listRoutingForProject(project_id);
  return rows.map(r => ({ label: r.label, member_name: r.member_name }));
}

export async function resolveLabel(project_id, label) {
  const { rows } = await pool.query(
    `SELECT r.label, m.id AS member_id
       FROM team_routing r
       JOIN team_members m ON m.id = r.member_id
      WHERE r.project_id = $1 AND r.label = $2`,
    [project_id, label]
  );
  if (!rows[0]) return null;
  const member = await findMember(rows[0].member_id);
  if (!member || !member.dev_bot) return null;
  return {
    member: {
      id: member.id,
      display_name: member.display_name,
      tg_user_id: member.tg_user_id
    },
    dev_bot: member.dev_bot
  };
}
