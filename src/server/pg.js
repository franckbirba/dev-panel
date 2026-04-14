// src/server/pg.js
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.PG_HOST || 'devpanel-postgres',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  user: process.env.PG_USER || 'affine',
  password: process.env.PG_PASSWORD || '',
  database: process.env.PG_DATABASE || 'agent_memory',
  max: 10
});

function vecLiteral(arr) {
  return `[${arr.join(',')}]`;
}

export async function memoryInsert({
  namespace, agent, kind, title, content,
  module_id = null, cycle_id = null, work_item_id = null,
  tags = [], embedding, expires_at = null
}) {
  const { rows } = await pool.query(
    `INSERT INTO memories
       (namespace, agent, kind, module_id, cycle_id, work_item_id,
        title, content, tags, embedding, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11)
     RETURNING id`,
    [namespace, agent, kind, module_id, cycle_id, work_item_id,
     title, content, tags, vecLiteral(embedding), expires_at]
  );
  return rows[0].id;
}

export async function memorySearchSql({
  namespace, embedding, kind = null, agent = null, module_id = null, limit = 5
}) {
  const params = [namespace, vecLiteral(embedding), limit];
  const clauses = ['namespace = $1'];
  if (kind)      { params.push(kind);      clauses.push(`kind = $${params.length}`); }
  if (agent)     { params.push(agent);     clauses.push(`agent = $${params.length}`); }
  if (module_id) { params.push(module_id); clauses.push(`module_id = $${params.length}`); }

  const sql = `
    SELECT id, agent, kind, title, content, module_id, cycle_id, work_item_id,
           tags, created_at,
           1 - (embedding <=> $2::vector) AS score
      FROM memories
     WHERE ${clauses.join(' AND ')}
     ORDER BY embedding <=> $2::vector
     LIMIT $3`;
  const { rows } = await pool.query(sql, params);
  return rows;
}

export async function memoryList({
  namespace, kind = null, agent = null, module_id = null, limit = 20
}) {
  const params = [namespace];
  const clauses = ['namespace = $1'];
  if (kind)      { params.push(kind);      clauses.push(`kind = $${params.length}`); }
  if (agent)     { params.push(agent);     clauses.push(`agent = $${params.length}`); }
  if (module_id) { params.push(module_id); clauses.push(`module_id = $${params.length}`); }
  params.push(limit);

  const sql = `
    SELECT id, agent, kind, title, content, module_id, cycle_id, work_item_id,
           tags, created_at
      FROM memories
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows;
}
