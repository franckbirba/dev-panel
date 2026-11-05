# CLI Agent Worker Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre les nouveaux drivers utilisables par le worker existant via `DRIVER_<AGENT>=kimi-cli` ou `claude-cli`, sans modifier le comportement par défaut.

**Architecture:** `spawnCliAgent` adapte `CliProcessDriver` au contrat historique du worker : événements persistés, `activeProcesses`, texte assistant final et erreur sur exit non nul. Le routage est opt-in et reste après le choix du conteneur.

**Tech Stack:** Node.js ESM, `child_process`, Vitest, Claude Code CLI, Kimi Code CLI.

---

### Task 1: Intégrer les adaptateurs dans le worker

**Files:**
- Create: `src/worker/cli-agent.js`
- Modify: `src/worker/index.js`
- Test: `tests/worker/cli-agent.test.js`
- Create: `docs/superpowers/plans/2026-11-03-cli-agent-integration.md`

- [ ] **Step 1: Écrire les tests d’intégration**

Vérifier sélection du driver, persistance des événements, enregistrement/retrait d’`activeProcesses`, résolution du texte assistant, rejet sur exit non nul et rejet d’un driver inconnu.

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `npx vitest run tests/worker/cli-agent.test.js`
Expected: FAIL, module `cli-agent.js` absent.

- [ ] **Step 3: Implémenter spawnCliAgent**

Créer le driver demandé, appeler `start`, persister chaque événement via `appendEvent`, enregistrer le processus dans `activeProcesses`, retirer l’entrée au close, puis résoudre le texte assistant ou rejeter avec le code de sortie.

- [ ] **Step 4: Ajouter le routage opt-in**

Dans `spawnAgent`, ajouter la lecture de `DRIVER_<AGENT>`/`DRIVER_DEFAULT` pour `kimi-cli` et `claude-cli` après le choix du conteneur et avant les autres drivers natifs. Ne changer aucun autre mode.

- [ ] **Step 5: Vérifier les tests et le smoke Kimi**

Run: `npx vitest run tests/worker/cli-agent.test.js tests/worker/claude-code-cli-driver.test.js tests/worker/kimi-code-cli-driver.test.js tests/worker/stream-parser.test.js`
Expected: PASS. Exécuter aussi `spawnCliAgent` réel avec Kimi sur un prompt sans outil.

- [ ] **Step 6: Committer**

```bash
git add src/worker/cli-agent.js src/worker/index.js tests/worker/cli-agent.test.js docs/superpowers/plans/2026-11-03-cli-agent-integration.md
git commit -m "feat(worker): intégrer les adaptateurs CLI au routage des agents"
```
