// src/worker/guard-driver.js
//
// Contrat §5/§6 pour TOUS les drivers, pas seulement Claude natif.
//
// Le gap trouvé en review (2026-08-20) : `spawnAgent` route vers pi /
// container / mini-swe / goose AVANT de câbler le contrôleur de timeout et
// le compteur de budget. Ces protections ne couvraient donc que la branche
// Claude — alors que la prod tourne avec DRIVER_DEFAULT=pi. Une garde qui
// ne protège que le chemin qu'on n'emprunte pas ne protège rien.
//
// Plutôt que de dupliquer le câblage dans les quatre drivers (quatre
// occasions de diverger), on l'applique ici, à l'endroit unique où le
// worker les appelle. Le driver garde une seule responsabilité : lancer le
// process et l'enregistrer dans `activeProcesses`. La surveillance est
// au-dessus.
//
// Mécanique : les drivers ne rendent pas leur `proc`, mais ils le déposent
// dans `activeProcesses` (contrat commun à tous — c'est ce qui rend
// `cancel_job` possible). On récupère l'entrée par polling court, on
// surveille, et on nettoie à la fin quoi qu'il arrive.
import { createProcessTimeoutController } from './process-timeout-controller.js';
import { agentTimeoutMs, stallTimeoutMs, killGraceMs, budgetTokensFor } from './timeout-policy.js';
import { isBudgetExceeded } from './token-usage.js';

const PICKUP_POLL_MS = 50;
const PICKUP_TIMEOUT_MS = 5000;

function killGroup(proc) {
  if (!proc?.pid) return;
  try { process.kill(-proc.pid, 'SIGTERM'); }
  catch { try { proc.kill('SIGTERM'); } catch { /* déjà mort */ } }
}

async function waitForProcess(activeProcesses, jobId, { pollMs = PICKUP_POLL_MS, timeoutMs = PICKUP_TIMEOUT_MS, isDone = () => false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = activeProcesses.get(String(jobId));
    if (entry?.process) return entry;
    // Si le driver a déjà rendu la main (spawn raté, run instantané), il n'y
    // aura jamais de process à surveiller : inutile d'attendre le timeout —
    // ça retarderait la propagation de l'erreur d'autant.
    if (isDone()) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

/**
 * Enveloppe l'appel d'un driver avec les protections §5/§6.
 *
 * @param {object} p
 * @param {() => Promise<string>} p.run      l'appel driver (spawnPi, spawnContainer…)
 * @param {Map} p.activeProcesses
 * @param {string|number} p.jobId
 * @param {string} p.agentRole
 * @param {(cb: (usage: object) => void) => void} [p.onUsageRegister]
 *        pour les drivers qui exposent un flux d'usage (pi via onUsage).
 * @returns {Promise<string>} le texte final du driver
 */
export async function guardDriverRun({ run, activeProcesses, jobId, agentRole, onUsageRegister }) {
  let killInfo = null;
  let controller = null;
  let totalTokens = 0;
  const budget = budgetTokensFor(agentRole);

  let runSettled = false;

  // Le driver démarre son process de façon asynchrone ; on l'attrape dès
  // qu'il apparaît dans activeProcesses, sans bloquer son exécution.
  const attach = (async () => {
    const entry = await waitForProcess(activeProcesses, jobId, { isDone: () => runSettled });
    if (!entry?.process) return; // driver instantané ou échec de spawn
    controller = createProcessTimeoutController({
      proc: entry.process,
      wallClockMs: agentTimeoutMs(agentRole),
      stallMs: stallTimeoutMs(),
      graceMs: killGraceMs(),
      onKill: (info) => { killInfo = info; },
    });
    // Un driver qui expose son usage (pi, via H6) alimente le budget ET
    // sert de battement de cœur pour la détection de stall : un agent qui
    // consomme des tokens est vivant.
    if (typeof onUsageRegister === 'function') {
      onUsageRegister((usage) => {
        controller.recordEvent();
        const t = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
        if (t > totalTokens) totalTokens = t;
        if (!killInfo && budget && isBudgetExceeded(totalTokens, budget)) {
          killInfo = { reason: 'budget', tokens: totalTokens, budgetTokens: budget };
          // Même geste que la branche Claude (index.js) : on arrête les
          // timers puis on tue le groupe. Le contrôleur n'expose pas de
          // kill public — c'est lui qui décide pour stall/wall-clock, le
          // budget est décidé ici.
          controller.stop();
          killGroup(entry.process);
        }
      });
    }
  })();

  try {
    const out = await run();
    return out;
  } catch (err) {
    // Le kill vient de nous : requalifier l'erreur générique du driver en
    // cause réelle, pour que la taxonomie §4.2 la classe correctement.
    if (killInfo) {
      err.failure_class = 'agent_failure';
      err.reason = killInfo.reason;
      err.killed_by_guard = true;
    }
    throw err;
  } finally {
    runSettled = true;
    controller?.stop?.();
    await attach.catch(() => {});
  }
}
