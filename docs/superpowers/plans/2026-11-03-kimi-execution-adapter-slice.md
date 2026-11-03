# Kimi Execution Adapter Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduire le premier `ExecutionAdapter` capable de lancer Kimi Code CLI en `stream-json`, de normaliser ses événements et de reprendre ou annuler un run sans appel direct à l’API Moonshot.

**Architecture:** Un adaptateur minimal expose `start`, `resume`, `cancel` et `capabilities`. Le driver Kimi construit les commandes documentées, consomme le JSONL réel observé sur Kimi 2.3.3 et délègue l’exécution à `child_process.spawn` injectable pour les tests.

**Tech Stack:** Node.js ESM, `child_process`, Vitest, Kimi Code CLI.

---

### Task 1: KimiCodeCliDriver et contrat de cycle de vie

**Files:**
- Create: `src/worker/execution-adapter.js`
- Create: `src/worker/kimi-code-cli-driver.js`
- Test: `tests/worker/kimi-code-cli-driver.test.js`
- Create: `docs/superpowers/plans/2026-11-03-kimi-execution-adapter-slice.md`

- [ ] **Step 1: Écrire les tests de commande et de mapping**

Couvrir : nouveau run, reprise avec `--session`, meta `system.version`, assistant texte, meta `session.resume_hint`, ligne non JSON et close 0/1. Vérifier aussi `cancel` et l’absence d’appel API direct.

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `npx vitest run tests/worker/kimi-code-cli-driver.test.js`
Expected: FAIL, module `kimi-code-cli-driver.js` absent.

- [ ] **Step 3: Définir ExecutionAdapter**

Exposer `capabilities()`, `start(runSpec)`, `resume(handle, input)`, `cancel(handle)` et `export(handle)`. Les méthodes non implémentées doivent échouer explicitement plutôt que simuler une capacité.

- [ ] **Step 4: Implémenter le driver Kimi**

`start` utilise `kimi -p <prompt> --output-format stream-json` ou ajoute `--session <id>`. Il retourne un handle avec processus, `native_session_id`, `run_id`, driver et statut. Le mapper produit `started`, `stdout`, `stderr`, `completed`, `failed` et `cancelled` avec les payloads du contrat. Le hint `session.resume_hint` alimente `native_session_id`. Le close 0 produit `completed`, les autres codes `failed`. `cancel` termine le processus et produit `cancelled` seulement après le close.

- [ ] **Step 5: Vérifier les tests et la suite worker**

Run: `npx vitest run tests/worker/kimi-code-cli-driver.test.js tests/worker/stream-parser.test.js`
Expected: PASS.

- [ ] **Step 6: Vérifier le diff et committer**

Run: `git diff --check`
Expected: aucune erreur.

```bash
git add src/worker/execution-adapter.js src/worker/kimi-code-cli-driver.js tests/worker/kimi-code-cli-driver.test.js docs/superpowers/plans/2026-11-03-kimi-execution-adapter-slice.md
git commit -m "feat(worker): ajouter le driver CLI Kimi à ExecutionAdapter"
```
