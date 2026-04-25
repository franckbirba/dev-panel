import express from 'express';
import {
  insertDevBot, listActiveDevBots, listAllDevBots,
  findDevBotById, revokeDevBot, updateDevBotOwner,
  validateTelegramToken
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
    const row = await findDevBotById(parseInt(req.params.id, 10));
    res.json(serialize(row));
  });

  app.use('/api/dev-bots', router);
}

function serialize(row) {
  if (!row) return null;
  return {
    ...row,
    owner_tg_user_id: row.owner_tg_user_id != null ? String(row.owner_tg_user_id) : null,
    paired_by_tg_user_id: String(row.paired_by_tg_user_id)
  };
}
