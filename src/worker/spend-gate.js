// src/worker/spend-gate.js
//
// Contrat §6, second volet : le plafond de dépense de la fleet.
//
// Arbitrage explicite de Franck (2026-08-18) : « ok, in the config, mais je
// ne veux pas que les agents s'arrêtent brutalement ». D'où une règle nette,
// différente de celle des budgets par job :
//
//   - budget PAR JOB (token-usage.js) → tue le job qui dépasse. C'est sa
//     propre consommation qui le condamne.
//   - plafond FLEET/JOUR (ici) → **gate à l'admission uniquement**. Un job
//     déjà lancé n'est JAMAIS tué parce que la fleet a beaucoup dépensé
//     aujourd'hui : il finit, éventuellement en produisant une PR. Ce qui
//     se ferme, c'est l'entrée.
//
// Conséquence : le plafond peut être dépassé (les jobs en vol continuent).
// C'est voulu — perdre le travail d'un builder à 90 % coûte plus cher que
// les tokens qu'il lui reste à brûler.
//
// La dépense du jour est lue depuis la table agent_job_log (source de
// vérité déjà alimentée par chaque job) plutôt que d'un compteur en mémoire,
// pour survivre au redémarrage du worker.

const DEFAULT_LIMIT_EUR = 15;

/** Le plafond configuré, ou null si non posé (aucun gate). */
export function fleetDailyLimitEur(env = process.env) {
  const raw = env.FLEET_DAILY_SPEND_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_LIMIT_EUR;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LIMIT_EUR;
  return n === 0 ? null : n; // 0 = explicitement désactivé
}

/**
 * Décide si un dispatch peut être admis.
 *
 * @param {object} p
 * @param {number} p.spentTodayEur   dépense déjà engagée aujourd'hui
 * @param {string} [p.priority]      p0/p1/p2/p3 — 'urgent'/'p0' passe outre
 * @param {number|null} [p.limitEur] plafond (défaut : celui de la config)
 * @returns {{ admitted: boolean, reason?: string, spent_today_eur: number, limit_eur: number|null }}
 */
export function checkSpendGate({ spentTodayEur, priority, limitEur = fleetDailyLimitEur() }) {
  const base = { spent_today_eur: spentTodayEur, limit_eur: limitEur };
  if (limitEur === null) return { admitted: true, ...base };

  if (spentTodayEur < limitEur) return { admitted: true, ...base };

  // Au-delà du plafond, seuls les dispatches urgents passent : une prod
  // cassée ne doit pas attendre minuit. Tout le reste est refusé avec une
  // raison lisible — le refus est explicite, jamais un silence.
  const urgent = priority === 'urgent' || priority === 'p0';
  if (urgent) {
    return { admitted: true, override: 'urgent', ...base };
  }
  return {
    admitted: false,
    reason: 'fleet_daily_spend_limit',
    detail: `plafond quotidien atteint (${spentTodayEur.toFixed(2)}€ / ${limitEur}€) — `
      + `les jobs en cours continuent, seuls les nouveaux dispatches non-urgents sont refusés. `
      + `Relever FLEET_DAILY_SPEND_LIMIT ou dispatcher en priority=urgent.`,
    ...base,
  };
}

/**
 * Dépense du jour (UTC) d'après agent_job_log. Retourne 0 si la table n'est
 * pas disponible : le gate ne doit jamais bloquer un dispatch parce que la
 * comptabilité est en panne (fail open — c'est un plafond de coût, pas une
 * garde de sécurité comme le readiness).
 */
export async function spentTodayEur(pool) {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total
         FROM agent_job_log
        WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC')`,
    );
    // cost_usd → EUR à taux fixe : la précision comptable n'est pas le sujet,
    // l'ordre de grandeur suffit pour un garde-fou.
    return Number(rows[0]?.total ?? 0) * 0.92;
  } catch {
    return 0;
  }
}
