import express from 'express';
import {
  insertDevBot, listActiveDevBots, listAllDevBots,
  findDevBotById, revokeDevBot, updateDevBotOwner,
  validateTelegramToken,
  addToAllowlist, removeFromAllowlist, listAllowlist
} from './dev-bots.js';

export function mountDevBotsRoutes(app) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const { token, label, paired_by_tg_user_id } = req.body ?? {};
    if (!token || !label || !paired_by_tg_user_id) {
      return res.status(400).json({ error: 'token, label, paired_by_tg_user_id required' });
    }
    const validation = await validateTelegramToken(token);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }
    try {
      const id = await insertDevBot({
        bot_token: token,
        bot_username: validation.username,
        bot_label: label,
        paired_by_tg_user_id: BigInt(paired_by_tg_user_id)
      });
      // Defensive: pairer should always be allowlisted to receive replies on
      // their own bot. Idempotent.
      await addToAllowlist({
        tg_user_id: BigInt(paired_by_tg_user_id),
        added_via: 'pair'
      });
      const row = await findDevBotById(id);
      res.status(201).json(serialize(row));
    } catch (err) {
      if (/duplicate|unique/i.test(err.message)) {
        return res.status(409).json({ error: 'bot already paired' });
      }
      throw err;
    }
  });

  router.get('/', async (req, res) => {
    const rows = req.query.status === 'active'
      ? await listActiveDevBots()
      : await listAllDevBots();
    res.json(rows.map(serialize));
  });

  router.delete('/:id', async (req, res) => {
    await revokeDevBot(parseInt(req.params.id, 10));
    res.status(204).end();
  });

  router.patch('/:id/owner', async (req, res) => {
    const { owner_tg_user_id, owner_first_name } = req.body ?? {};
    await updateDevBotOwner(parseInt(req.params.id, 10), {
      owner_tg_user_id: owner_tg_user_id ? BigInt(owner_tg_user_id) : null,
      owner_first_name: owner_first_name ?? null
    });
    // Auto-allowlist on first inbound — this is the moment we learn who the
    // dev actually is, and we want them to be able to chat without manual
    // allowlist mutation.
    if (owner_tg_user_id) {
      await addToAllowlist({
        tg_user_id: BigInt(owner_tg_user_id),
        first_name: owner_first_name ?? null,
        added_via: 'first_inbound'
      });
    }
    const row = await findDevBotById(parseInt(req.params.id, 10));
    res.json(serialize(row));
  });

  // Allowlist as its own resource — used by the plugin (read), and for
  // manual onboarding/revocation by Franck.
  const allowRouter = express.Router();
  allowRouter.get('/', async (_req, res) => {
    const rows = await listAllowlist();
    res.json(rows.map(r => ({ ...r, tg_user_id: String(r.tg_user_id) })));
  });
  allowRouter.post('/', async (req, res) => {
    const { tg_user_id, first_name } = req.body ?? {};
    if (!tg_user_id) return res.status(400).json({ error: 'tg_user_id required' });
    await addToAllowlist({
      tg_user_id: BigInt(tg_user_id),
      first_name: first_name ?? null,
      added_via: 'manual'
    });
    res.status(201).json({ tg_user_id: String(tg_user_id) });
  });
  allowRouter.delete('/:tg_user_id', async (req, res) => {
    await removeFromAllowlist(BigInt(req.params.tg_user_id));
    res.status(204).end();
  });

  router.get('/available', async (req, res) => {
    const project = req.query.project;
    if (!project) return res.status(400).json({ error: 'project query param required' });
    const { pool: pg } = await import('./pg.js');
    const { rows } = await pg.query(
      `SELECT b.id, b.bot_label, b.bot_username, b.owner_first_name
         FROM dev_bots b
        WHERE b.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM team_members m
             WHERE m.project_id = $1 AND m.dev_bot_id = b.id
          )
        ORDER BY b.id`,
      [project]
    );
    res.json(rows);
  });

  app.use('/api/dev-bots', router);
  app.use('/api/dev-bot-allowlist', allowRouter);
}

function serialize(row) {
  if (!row) return null;
  return {
    ...row,
    owner_tg_user_id: row.owner_tg_user_id != null ? String(row.owner_tg_user_id) : null,
    paired_by_tg_user_id: String(row.paired_by_tg_user_id)
  };
}
