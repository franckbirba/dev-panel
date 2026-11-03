# Claude Execution Adapter Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter `ClaudeCodeCliDriver` derrière `ExecutionAdapter`, avec le même cycle de vie et les mêmes preuves que Kimi, sans dupliquer le runner JSONL.

**Architecture:** Extraire le processus JSONL partagé dans `CliProcessDriver`. Les drivers Claude et Kimi ne définissent que leurs commandes et le mapping de leurs événements natifs. Aucun appel direct aux API modèles.

**Tech Stack:** Node.js ESM, `child_process`, Vitest, Claude Code CLI, Kimi Code CLI.

---

### Task 1: Factoriser le runner JSONL et ajouter Claude

**Files:**
- Create: `src/worker/cli-process-driver.js`
- Create: `src/worker/claude-code-cli-driver.js`
- Modify: `src/worker/kimi-code-cli-driver.js`
- Test: `tests/worker/claude-code-cli-driver.test.js`
- Modify: `tests/worker/kimi-code-cli-driver.test.js`

- [ ] **Step 1: Écrire les tests Claude**

Couvrir la commande `claude -p … --output-format stream-json --verbose`, les messages assistant texte, `tool_use`, `tool_result`, la session native, l’artefact hashé, l’échec et l’annulation. Vérifier que les tests Kimi restent identiques.

- [ ] **Step 2: Vérifier que les tests échouent**

Run: `npx vitest run tests/worker/claude-code-cli-driver.test.js tests/worker/kimi-code-cli-driver.test.js`
Expected: FAIL, module `claude-code-cli-driver.js` absent.

- [ ] **Step 3: Extraire CliProcessDriver**

Déplacer le spawn, les buffers, les événements, la session native, l’annulation et le journal hashé depuis Kimi vers `CliProcessDriver`, avec hooks `buildInvocation` et `handleNativeEvent`. Conserver exactement le comportement Kimi existant.

- [ ] **Step 4: Implémenter ClaudeCodeCliDriver**

Utiliser la commande Claude documentée et mapper `assistant` texte, `tool_use`, `tool_result` et `result` vers les événements normalisés. Ne pas contourner les permissions et ne pas utiliser `--dangerously-skip-permissions`.

- [ ] **Step 5: Vérifier les tests**

Run: `npx vitest run tests/worker/claude-code-cli-driver.test.js tests/worker/kimi-code-cli-driver.test.js tests/worker/stream-parser.test.js`
Expected: PASS pour tous les tests ciblés.

- [ ] **Step 6: Committer**

```bash
git add src/worker/cli-process-driver.js src/worker/claude-code-cli-driver.js src/worker/kimi-code-cli-driver.js tests/worker/claude-code-cli-driver.test.js tests/worker/kimi-code-cli-driver.test.js docs/superpowers/plans/2026-11-03-claude-execution-adapter-slice.md
git commit -m "feat(worker): mutualiser les drivers CLI Claude et Kimi"
```
