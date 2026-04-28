// Build and broadcast a release note when a pull request gets merged.
// Triggered by webhooks-github.js on pull_request.closed + merged=true.

import { pool } from './pg.js';

export async function recordBroadcast(syntheticId) {
  const { rows } = await pool.query(
    `INSERT INTO release_broadcasts (synthetic_id)
     VALUES ($1)
     ON CONFLICT (synthetic_id) DO NOTHING
     RETURNING synthetic_id`,
    [syntheticId]
  );
  return { inserted: rows.length > 0 };
}
