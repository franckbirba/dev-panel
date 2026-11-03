# OpenCode CLI Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter OpenCode comme driver optionnel derrière `CliProcessDriver`, avec le même contrat que Claude et Kimi.

**Architecture:** Le driver mappe `step_start` pour la session native et `text` pour la sortie assistant. Le routage `opencode-cli` est opt-in et ne change aucun comportement par défaut.

**Tech Stack:** Node.js ESM, OpenCode 2.1.4, Vitest.

---

### Task 1: Ajouter OpenCodeCliDriver

**Files:**
- Create: `src/worker/opencode-cli-driver.js`
- Modify: `src/worker/cli-agent.js`
- Modify: `src/worker/index.js`
- Test: `tests/worker/opencode-cli-driver.test.js`

- [ ] **Step 1: Écrire les tests**

Vérifier `opencode run <prompt> --format json`, session native, texte, artefact, échec et annulation.

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `npx vitest run tests/worker/opencode-cli-driver.test.js`
Expected: FAIL, module absent.

- [ ] **Step 3: Implémenter le driver**

Mapper `step_start.sessionID` vers `native_session_id`, `part.text` vers `stdout`, et réutiliser le runner partagé pour les artefacts et statuts.

- [ ] **Step 4: Ajouter le routage opt-in**

Enregistrer `opencode-cli` dans la factory et dans le routage worker.

- [ ] **Step 5: Vérifier mocks et smoke réel**

Run: `npx vitest run tests/worker/opencode-cli-driver.test.js tests/worker/cli-agent.test.js tests/worker/claude-code-cli-driver.test.js tests/worker/kimi-code-cli-driver.test.js tests/worker/stream-parser.test.js`
Expected: PASS. Exécuter aussi `opencode run` réel sur un prompt sans outil.

- [ ] **Step 6: Committer et pousser**

```bash
git add src/worker/opencode-cli-driver.js src/worker/cli-agent.js src/worker/index.js tests/worker/opencode-cli-driver.test.js docs/superpowers/plans/2026-11-03-opencode-cli-driver.md
git commit -m "feat(worker): ajouter le driver optionnel OpenCode"
git push
```
