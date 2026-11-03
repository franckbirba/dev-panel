# CLI Event Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Empêcher les secrets présents dans les sorties et appels d’outils d’être persistés dans les événements et artefacts CLI.

**Architecture:** Une fonction `redactText` et son équivalent récursif pour les payloads remplace les secrets par `[REDACTED]` avant toute émission ou écriture du journal. Les modifications restent bornées au runner partagé et aux tests.

**Tech Stack:** Node.js ESM, Vitest.

---

### Task 1: Expurger les payloads avant persistance

**Files:**
- Create: `src/worker/redact-text.js`
- Modify: `src/worker/cli-process-driver.js`
- Test: `tests/worker/redact-text.test.js`
- Modify: `tests/worker/kimi-code-cli-driver.test.js`

- [ ] **Step 1: Écrire les tests de non-fuite**

Couvrir Bearer, `sk-`, affectations `api_key/token/secret/password`, URLs avec credentials et objets imbriqués. Ajouter un test prouvant que le journal ne contient pas le secret original mais contient `[REDACTED]`.

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `npx vitest run tests/worker/redact-text.test.js tests/worker/kimi-code-cli-driver.test.js`
Expected: FAIL, `redactText` absent et secret présent dans le journal.

- [ ] **Step 3: Implémenter redactText et redactValue**

Appliquer des remplacements ciblés sans modifier les autres contenus. Parcourir récursivement objets et tableaux sans altérer les types non textuels.

- [ ] **Step 4: Appliquer avant emit**

Passer chaque payload par `redactValue` avant `appendFileSync` et `onEvent`, de sorte que journal et consommateurs reçoivent la même version expurgée.

- [ ] **Step 5: Vérifier les tests**

Run: `npx vitest run tests/worker/redact-text.test.js tests/worker/kimi-code-cli-driver.test.js tests/worker/claude-code-cli-driver.test.js tests/worker/cli-agent.test.js tests/worker/stream-parser.test.js`
Expected: PASS.

- [ ] **Step 6: Committer et pousser**

```bash
git add src/worker/redact-text.js src/worker/cli-process-driver.js tests/worker/redact-text.test.js tests/worker/kimi-code-cli-driver.test.js docs/superpowers/plans/2026-11-03-cli-event-redaction.md
git commit -m "fix(worker): expurger les secrets des événements CLI"
git push
```
