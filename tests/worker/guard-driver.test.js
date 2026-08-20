// Contrat §5/§6 pour les drivers alternatifs.
//
// Gap trouvé en review C2 (2026-08-20) : spawnAgent routait vers pi /
// container / mini-swe / goose AVANT de câbler le contrôleur de timeout et
// le budget. Ces protections ne couvraient donc que la branche Claude —
// alors que la prod tourne avec DRIVER_DEFAULT=pi. Une garde qui ne protège
// que le chemin qu'on n'emprunte pas ne protège rien.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { guardDriverRun } from '../../src/worker/guard-driver.js';

// Faux process : on n'a besoin que d'un pid et d'un kill observable.
function fakeProc(pid = 4242) {
  const p = new EventEmitter();
  p.pid = pid;
  p.kill = vi.fn();
  return p;
}

describe('guardDriverRun', () => {
  it('laisse passer le résultat quand le driver termine normalement', async () => {
    const activeProcesses = new Map();
    const out = await guardDriverRun({
      activeProcesses, jobId: '1', agentRole: 'builder',
      run: async () => {
        activeProcesses.set('1', { process: fakeProc(), startedAt: Date.now() });
        return 'résultat du driver';
      },
    });
    expect(out).toBe('résultat du driver');
  });

  it('n\'échoue pas si le driver ne dépose jamais de process (spawn raté)', async () => {
    const activeProcesses = new Map();
    await expect(guardDriverRun({
      activeProcesses, jobId: 'jamais', agentRole: 'builder',
      run: async () => { throw new Error('spawn failed: ENOENT'); },
    })).rejects.toThrow(/ENOENT/);
  });

  it('tue le process et requalifie l\'erreur quand le budget est dépassé', async () => {
    const activeProcesses = new Map();
    const proc = fakeProc();
    process.env.BUDGET_TOKENS_BUILDER = '100';
    let resolveRun;
    const runPromise = new Promise((r) => { resolveRun = r; });

    const guarded = guardDriverRun({
      activeProcesses, jobId: '2', agentRole: 'builder',
      onUsageRegister: (cb) => {
        // Le driver publie son usage : on simule un dépassement franc.
        setTimeout(() => {
          cb({ input_tokens: 90, output_tokens: 50 }); // 140 > 100
          // Le driver meurt derrière, comme le ferait un vrai process tué.
          resolveRun();
        }, 80);
      },
      run: async () => {
        activeProcesses.set('2', { process: proc, startedAt: Date.now() });
        await runPromise;
        const err = new Error('pi exited with code 143');
        throw err;
      },
    });

    await expect(guarded).rejects.toMatchObject({
      failure_class: 'agent_failure',
      reason: 'budget',
      killed_by_guard: true,
    });
    delete process.env.BUDGET_TOKENS_BUILDER;
  });

  it('laisse l\'erreur du driver intacte quand ce n\'est PAS nous qui avons tué', async () => {
    const activeProcesses = new Map();
    const err = await guardDriverRun({
      activeProcesses, jobId: '3', agentRole: 'builder',
      run: async () => {
        activeProcesses.set('3', { process: fakeProc(), startedAt: Date.now() });
        throw new Error('vrai plantage du modèle');
      },
    }).catch((e) => e);

    expect(err.message).toMatch(/vrai plantage/);
    expect(err.killed_by_guard).toBeUndefined();
    expect(err.reason).toBeUndefined();
  });

  it('ne compte pas deux fois un usage cumulatif (pi envoie des totaux)', async () => {
    const activeProcesses = new Map();
    process.env.BUDGET_TOKENS_BUILDER = '100';
    let emit;
    const guarded = guardDriverRun({
      activeProcesses, jobId: '4', agentRole: 'builder',
      onUsageRegister: (cb) => { emit = cb; },
      run: async () => {
        activeProcesses.set('4', { process: fakeProc(), startedAt: Date.now() });
        await new Promise((r) => setTimeout(r, 120));
        // Trois snapshots CUMULATIFS sous le budget : additionnés à tort,
        // ils le dépasseraient (30+60+90=180 > 100).
        emit({ input_tokens: 10, output_tokens: 20 });
        emit({ input_tokens: 30, output_tokens: 30 });
        emit({ input_tokens: 40, output_tokens: 50 });
        return 'terminé sans kill';
      },
    });
    await expect(guarded).resolves.toBe('terminé sans kill');
    delete process.env.BUDGET_TOKENS_BUILDER;
  });
});
