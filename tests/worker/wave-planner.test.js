// ADR-001 — orchestration multi-items : topo-sort sur les relations Plane
// blocked_by, vagues bornées par max_parallel, re-tick au merge.
import { describe, it, expect } from 'vitest';
import { planWave, nextFront, applyMerged } from '../../src/worker/wave-planner.js';

const items = (spec) =>
  Object.entries(spec).map(([id, blocked_by]) => ({ id, blocked_by }));

describe('planWave', () => {
  it('met les items sans blocker au premier front', () => {
    const plan = planWave(items({ a: [], b: [], c: ['a'] }));
    expect(plan.fronts[0].sort()).toEqual(['a', 'b']);
  });

  it('ordonne une chaîne en autant de fronts que de maillons', () => {
    const plan = planWave(items({ a: [], b: ['a'], c: ['b'] }));
    expect(plan.fronts).toEqual([['a'], ['b'], ['c']]);
  });

  it('refuse un cycle en le nommant', () => {
    expect(() => planWave(items({ a: ['c'], b: ['a'], c: ['b'] })))
      .toThrow(/cycle/i);
  });

  it('ignore un blocker hors périmètre de la vague (déjà mergé ailleurs)', () => {
    const plan = planWave(items({ a: ['externe-42'], b: ['a'] }));
    expect(plan.fronts).toEqual([['a'], ['b']]);
  });

  it('rejette un item dupliqué', () => {
    expect(() => planWave([{ id: 'a', blocked_by: [] }, { id: 'a', blocked_by: [] }]))
      .toThrow(/dupliqu/i);
  });
});

describe('nextFront', () => {
  const plan = planWave(items({ a: [], b: [], c: ['a'], d: ['a', 'b'] }));

  it('borne le dispatch initial à max_parallel', () => {
    expect(nextFront(plan, { merged: [], running: [], max_parallel: 1 })).toEqual(['a']);
  });

  it('ne redispatche pas un item déjà en cours', () => {
    expect(nextFront(plan, { merged: [], running: ['a'], max_parallel: 2 })).toEqual(['b']);
  });

  it('arme les dépendants dès que leurs blockers sont mergés', () => {
    const armed = nextFront(plan, { merged: ['a', 'b'], running: [], max_parallel: 5 });
    expect(armed.sort()).toEqual(['c', 'd']);
  });

  it('garde un item bloqué tant que TOUS ses blockers ne sont pas mergés', () => {
    // a mergé → c est armable (seul blocker a) ; d ne l'est pas (attend aussi b).
    // b reste armable : il n'a jamais eu de blocker.
    const armed = nextFront(plan, { merged: ['a'], running: [], max_parallel: 5 });
    expect(armed).toContain('c');
    expect(armed).not.toContain('d');
  });

  it('ne dispatche rien quand tout est mergé', () => {
    expect(nextFront(plan, { merged: ['a', 'b', 'c', 'd'], running: [], max_parallel: 5 })).toEqual([]);
  });
});

describe('applyMerged', () => {
  const plan = planWave(items({ a: [], b: ['a'], c: ['b'] }));

  it('avance l\'état et retourne les items débloqués par ce merge', () => {
    const state = { merged: [], running: ['a'], failed: [], max_parallel: 2 };
    const out = applyMerged(plan, state, 'a');
    expect(out.unblocked).toEqual(['b']);
    expect(out.state.merged).toEqual(['a']);
    expect(out.state.running).toEqual([]);
  });

  it('gèle les dépendants d\'un item failed, sans bloquer le reste', () => {
    const wide = planWave(items({ a: [], b: ['a'], z: [] }));
    const state = { merged: [], running: ['a', 'z'], failed: ['a'], max_parallel: 2 };
    expect(nextFront(wide, state)).toEqual([]);       // b reste gelé (blocker failed)
    expect(applyMerged(wide, state, 'z').state.merged).toContain('z');
  });

  it('marque la vague done quand tous les items sont mergés', () => {
    let state = { merged: ['a', 'b'], running: ['c'], failed: [], max_parallel: 2 };
    const out = applyMerged(plan, state, 'c');
    expect(out.state.status).toBe('done');
  });

  it('marque partial quand un item a échoué et que plus rien ne peut avancer', () => {
    const state = { merged: [], running: [], failed: ['a'], max_parallel: 2 };
    const out = applyMerged(plan, state, null);
    expect(out.state.status).toBe('partial');
  });
});
