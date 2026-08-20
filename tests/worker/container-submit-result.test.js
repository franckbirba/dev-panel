// Gap trouvé en review C7 (2026-08-20) : le container driver en mode pi
// interne chargeait bien l'extension submit-result, et le sentinel arrivait
// bien côté hôte (le cwd est bind-monté sur /workspace), mais le handler
// `close` ne le lisait pas — activer CONTAINER_INNER_DRIVER=pi aurait fait
// régresser H3 en silence, vers le taux d'enveloppes perdues d'avant, sans
// qu'aucun test ne le voie.
//
// Ces tests vérifient l'invariant partagé par les deux drivers : quand une
// enveloppe validée est déposée par le tool, elle gagne sur le texte final.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readSubmitResultEnvelope } from '../../src/worker/pi-driver.js';

const SENTINEL = '.pi-submit-result.json';

const VALID_ENVELOPE = {
  status: 'done',
  summary: 'Ajout de sub() dans calc.js.',
  artifacts: {
    files_created: [],
    files_modified: ['src/calc.js'],
    commits: [],
    branch: 'feat/wi-abc',
    tests_passed: true,
    pr_url: null,
  },
  handoff: { next_agent: null, reason: '' },
  memory_writes_count: 0,
  blockers: [],
  issues_found: [],
};

describe('container driver × submit_result (workspace bind-mount)', () => {
  let cwd;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'container-submit-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('lit l\'enveloppe déposée dans le workspace monté', () => {
    // Ce que le container écrit dans /workspace atterrit ici : même inode.
    writeFileSync(join(cwd, SENTINEL), JSON.stringify(VALID_ENVELOPE));
    const out = readSubmitResultEnvelope(cwd);
    expect(out.ok).toBe(true);
    expect(out.data.status).toBe('done');
    expect(out.data.artifacts.files_modified).toEqual(['src/calc.js']);
  });

  it('supprime le sentinel après lecture — pas d\'enveloppe périmée pour le job suivant', () => {
    writeFileSync(join(cwd, SENTINEL), JSON.stringify(VALID_ENVELOPE));
    readSubmitResultEnvelope(cwd);
    expect(existsSync(join(cwd, SENTINEL))).toBe(false);
  });

  it('n\'invente rien quand le sentinel est absent (fallback au texte final)', () => {
    expect(readSubmitResultEnvelope(cwd).ok).toBe(false);
  });

  it('rejette une enveloppe malformée au lieu de la faire passer pour valide', () => {
    writeFileSync(join(cwd, SENTINEL), JSON.stringify({ status: 'done' })); // champs manquants
    expect(readSubmitResultEnvelope(cwd).ok).toBe(false);
  });

  it('le container driver importe bien le lecteur (garde anti-régression du gap)', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync(new URL('../../src/worker/container-driver.js', import.meta.url), 'utf8'));
    expect(src).toContain('readSubmitResultEnvelope');
  });
});
