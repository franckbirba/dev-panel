# S2 — Fix du crash devpanel-api sur les tools MCP SSH — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un appel à `host_status` / `run_remote_check` / `tail_log` / `ssh_status` ne peut plus tuer le process Express, même si le binaire `ssh` est absent du container ou si l'hôte est injoignable.

**Architecture:** cause racine identifiée — 4 copies de `execSsh` (`src/mcp/runtime.js:50`, `src/capabilities/run-remote-check.js`, `src/capabilities/host-status.js:9`, `src/capabilities/tail-log-snapshot.js:9`) **sans handler `child.on('error')`** : quand `spawn('ssh', …)` échoue (ENOENT dans le container devpanel-api), l'événement `error` sans listener jette une exception non capturée → le process meurt (reproduit 3/3 le 18/08, container « Up 3 minutes »). Fix : une seule implémentation durcie dans `src/lib/exec-ssh.js` (error handler + timeout + jamais de reject), les 4 fichiers l'importent. Long terme (ADR-003) : ces checks migreront vers le canal worker — ce plan est le fix tactique « ne plus crasher ».

**Tech Stack:** Node ESM, `child_process.spawn`, vitest.

---

### Task 1: `src/lib/exec-ssh.js` — l'implémentation durcie

**Files:**
- Create: `src/lib/exec-ssh.js`
- Test: `tests/lib/exec-ssh.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib/exec-ssh.test.js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSsh } from '../../src/lib/exec-ssh.js';

describe('execSsh', () => {
  it('resolves (never throws) when the ssh binary does not exist', async () => {
    const r = await execSsh('deploy@host', 'uptime', { sshBin: '/nonexistent/ssh' });
    expect(r.exitCode).toBe(-2);
    expect(r.stderr).toMatch(/ENOENT|spawn/);
  });

  it('resolves with stdout and exitCode 0 on success', async () => {
    // `echo` accepts any argv and exits 0 — stands in for a working ssh.
    const r = await execSsh('deploy@host', 'uptime', { sshBin: 'echo' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('deploy@host');
  });

  it('resolves with exitCode -1 and [timeout] marker when the process hangs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'execssh-'));
    const slow = join(dir, 'slow-ssh');
    writeFileSync(slow, '#!/bin/sh\nsleep 60\n');
    chmodSync(slow, 0o755);
    const r = await execSsh('deploy@host', 'uptime', { sshBin: slow, timeoutMs: 200 });
    expect(r.exitCode).toBe(-1);
    expect(r.stderr).toContain('[timeout]');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lib/exec-ssh.test.js`
Expected: FAIL — `Cannot find module '../../src/lib/exec-ssh.js'`

- [ ] **Step 3: Implement**

```js
// src/lib/exec-ssh.js
//
// LA copie canonique de execSsh — remplace les 4 copies locales qui
// crashaient devpanel-api : sans handler `child.on('error')`, un spawn qui
// échoue (binaire ssh absent du container) émet un événement 'error' sans
// listener → exception non capturée → le process Express meurt (constaté
// 3/3 à l'audit du 2026-08-18). Contrat : cette fonction ne rejette JAMAIS.
//
// exitCode conventions: 0..255 = exit réel · -1 = timeout · -2 = spawn error.
import { spawn } from 'node:child_process';

export function execSsh(target, command, { timeoutMs = 15_000, sshBin = 'ssh' } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ durationMs: Date.now() - start, ...result });
    };

    let child;
    try {
      child = spawn(sshBin, [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=accept-new',
        target,
        command,
      ]);
    } catch (err) {
      return done({ stdout: '', stderr: String(err), exitCode: -2 });
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      done({ stdout, stderr: stderr + '\n[timeout]', exitCode: -1 });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      done({ stdout, stderr: stderr + String(err), exitCode: -2 });
    });
    child.on('close', (code) => {
      done({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/lib/exec-ssh.test.js`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/lib/exec-ssh.js tests/lib/exec-ssh.test.js
git commit -m "fix(mcp): execSsh durci — error handler, jamais de reject (crash API S2)"
```

### Task 2: Refactor des 4 call sites

**Files:**
- Modify: `src/mcp/runtime.js` (supprimer `execSsh` local lignes 50-77, importer)
- Modify: `src/capabilities/run-remote-check.js` (idem)
- Modify: `src/capabilities/host-status.js` (idem, ligne 9)
- Modify: `src/capabilities/tail-log-snapshot.js` (idem, ligne 9)

- [ ] **Step 1:** Dans chaque fichier : supprimer la fonction `execSsh` locale et l'import `spawn` devenu inutile, ajouter en tête :

```js
import { execSsh } from '../lib/exec-ssh.js';
```

(Le chemin est identique depuis `src/mcp/` et `src/capabilities/` — les deux sont frères de `src/lib/`.) Les signatures d'appel existantes (`execSsh(target, cmd, { timeoutMs })`) sont inchangées — le nouveau paramètre `sshBin` a un défaut.

- [ ] **Step 2:** Vérifier qu'aucune copie ne reste : `grep -rn "function execSsh" src/` → doit retourner uniquement `src/lib/exec-ssh.js`.

- [ ] **Step 3:** Run: `npx vitest run tests/lib/ tests/server/ 2>&1 | tail -5` — aucune régression.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/runtime.js src/capabilities/run-remote-check.js src/capabilities/host-status.js src/capabilities/tail-log-snapshot.js
git commit -m "refactor(mcp): les 4 tools SSH partagent src/lib/exec-ssh.js"
```

### Task 3: Test de non-crash au niveau du handler (le scénario prod exact)

**Files:**
- Test: `tests/capabilities/ssh-tools-no-crash.test.js`

- [ ] **Step 1: Write the test** — reproduit le crash prod : PATH vide → `spawn('ssh')` ENOENT → le handler doit **résoudre** un payload d'erreur, pas tuer le process.

```js
// tests/capabilities/ssh-tools-no-crash.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runRemoteCheck } from '../../src/capabilities/run-remote-check.js';
import { hostStatus } from '../../src/capabilities/host-status.js';

describe('SSH tools survive a missing ssh binary (prod crash 2026-08-18)', () => {
  let origPath;
  beforeEach(() => { origPath = process.env.PATH; process.env.PATH = '/nonexistent'; });
  afterEach(() => { process.env.PATH = origPath; });

  it('run_remote_check resolves an error payload instead of crashing', async () => {
    const r = await runRemoteCheck.handler({ host: 'services', command_id: 'redis-ping' });
    expect(r.exit_code).toBe(-2);
    expect(r.stderr).toMatch(/ENOENT|spawn/);
  });

  it('host_status resolves an error payload instead of crashing', async () => {
    const r = await hostStatus.handler({ host: 'services' });
    // host-status formatte l'erreur — le seul contrat ici : on résout, on ne throw pas.
    expect(r).toBeDefined();
  });
});
```

- [ ] **Step 2:** Run: `npx vitest run tests/capabilities/ssh-tools-no-crash.test.js` — Expected: 2 passed. (Si `host_status.handler` throw au lieu de résoudre : envelopper son corps dans le même pattern erreur-payload que `run_remote_check` — c'est le bug qu'on corrige.)

- [ ] **Step 3: Commit**

```bash
git add tests/capabilities/ssh-tools-no-crash.test.js
git commit -m "test(mcp): les tools SSH survivent à un binaire ssh absent"
```

### Task 4: Vérification prod (post-merge, manuel)

- [ ] Déployer (push main → CI). Puis : appeler `host_status` depuis un client MCP → réponse d'erreur propre OU données ; `docker ps` sur services → devpanel-api **ne redémarre pas**. C'est le critère de l'audit (« Up 3 minutes » ne doit plus jamais se reproduire par ce chemin).
