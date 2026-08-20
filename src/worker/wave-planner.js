// src/worker/wave-planner.js — ADR-001, orchestration multi-items.
//
// Le moteur sait exécuter UN work item ; il ne savait rien de l'ordre ENTRE
// items. Or le travail réel arrive en cycles ordonnés (Zeno V2 : le kernel
// précède le resolver, qui précède les pilotes). Ce séquencement vivait dans
// la tête de Franck et se payait en babysitting : dispatcher, surveiller,
// dispatcher le suivant.
//
// Ce module est du calcul pur — pas d'I/O, pas de BullMQ, pas de Plane. Les
// relations `blocked_by` viennent de Plane (source de vérité, aucune table
// devpanl), l'exécution vient du worker. Ici : topo-sort, détection de cycles,
// et la décision « qui peut partir maintenant ».
//
// Délibérément PAS un DAG engine générique (YAGNI) : un seul pattern réel,
// les vagues merge-gated.

/**
 * Construit le plan d'une vague : les fronts d'exécution, du plus contraint
 * au moins contraint. Rejette les cycles — un cycle de dépendances est une
 * erreur de saisie dans Plane, pas un cas à contourner.
 *
 * @param {Array<{id: string, blocked_by?: string[]}>} items
 * @returns {{ items: string[], blockers: Map<string,string[]>, fronts: string[][] }}
 */
export function planWave(items) {
  const ids = items.map((i) => i.id);
  const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
  if (dupes.length) {
    throw new Error(`wave: work item dupliqué dans la vague: ${[...new Set(dupes)].join(', ')}`);
  }
  const inWave = new Set(ids);

  // Un blocker hors de la vague est ignoré : soit il est déjà mergé, soit il
  // n'est pas de notre ressort. La garde au dispatch (ADR-001 §2) refuse de
  // toute façon un item dont un blocker externe n'est pas Done.
  const blockers = new Map(
    items.map((i) => [i.id, (i.blocked_by || []).filter((b) => inWave.has(b))]),
  );

  const fronts = [];
  const placed = new Set();
  while (placed.size < ids.length) {
    const front = ids.filter(
      (id) => !placed.has(id) && blockers.get(id).every((b) => placed.has(b)),
    );
    if (front.length === 0) {
      const stuck = ids.filter((id) => !placed.has(id));
      throw new Error(
        `wave: cycle de dépendances détecté entre: ${stuck.join(' → ')} — corrige les relations blocked_by dans Plane`,
      );
    }
    fronts.push(front);
    front.forEach((id) => placed.add(id));
  }
  return { items: ids, blockers, fronts };
}

/**
 * Qui peut partir maintenant : items dont tous les blockers sont mergés, qui
 * ne tournent pas déjà, ne sont pas terminés, et dont aucun blocker n'a
 * échoué (un échec gèle ses dépendants — le reste de la vague continue).
 * Borné par max_parallel, places occupées déduites.
 */
export function nextFront(plan, { merged = [], running = [], failed = [], max_parallel = 2 }) {
  const mergedSet = new Set(merged);
  const runningSet = new Set(running);
  const failedSet = new Set(failed);
  const slots = Math.max(0, max_parallel - runningSet.size);
  if (slots === 0) return [];

  const frozen = (id) => {
    // Gelé si un blocker (direct ou transitif) a échoué.
    const seen = new Set();
    const walk = (n) => {
      for (const b of plan.blockers.get(n) || []) {
        if (failedSet.has(b)) return true;
        if (!seen.has(b)) { seen.add(b); if (walk(b)) return true; }
      }
      return false;
    };
    return walk(id);
  };

  return plan.items
    .filter((id) => !mergedSet.has(id) && !runningSet.has(id) && !failedSet.has(id))
    .filter((id) => (plan.blockers.get(id) || []).every((b) => mergedSet.has(b)))
    .filter((id) => !frozen(id))
    .slice(0, slots);
}

/**
 * Applique un merge (ou une simple ré-évaluation si mergedId est null) et
 * retourne le nouvel état + les items que ce merge vient de débloquer.
 *
 * Statuts de vague : running → done (tout mergé) | partial (plus rien ne peut
 * avancer alors qu'il reste des items).
 */
export function applyMerged(plan, state, mergedId) {
  const merged = [...new Set(mergedId ? [...state.merged, mergedId] : state.merged)];
  const running = state.running.filter((id) => id !== mergedId);
  const failed = state.failed || [];
  const next = { ...state, merged, running, failed };

  const unblocked = nextFront(plan, { ...next, max_parallel: Infinity })
    .filter((id) => !mergedId || (plan.blockers.get(id) || []).includes(mergedId));

  const remaining = plan.items.filter((id) => !merged.includes(id) && !failed.includes(id));
  if (remaining.length === 0) {
    next.status = failed.length ? 'partial' : 'done';
  } else if (running.length === 0 && nextFront(plan, next).length === 0) {
    // Rien en vol, rien d'armable : la vague ne progressera plus seule.
    next.status = 'partial';
  } else {
    next.status = 'running';
  }
  return { state: next, unblocked };
}
