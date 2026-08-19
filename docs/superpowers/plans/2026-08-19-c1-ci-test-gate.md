# C1 — CI test gate + réparation des tests cassés — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** la suite vitest passe entière sur main, et tourne sur chaque PR — préalable à tous les autres chantiers de Phase C.

**Architecture:** trois familles de casse identifiées à l'audit (14/861 échecs) : un export manquant (`handleThreadAppend`), un mock rassis (`writeSubjectLink`), une fixture périmée (`RENDERER_PAYLOAD_TYPES` 7 vs 8). Puis un job `tests` dans `pr-checks.yml`. Le flaky connu (`tests/worker/bootstrap-project.test.js`, timeout en suite complète seulement — mémoire studio) est traité par un retry documenté, pas ignoré silencieusement.

**Tech Stack:** vitest, GitHub Actions, Node 22.

---

### Task 1: Exporter `handleThreadAppend`

**Files:**
- Modify: `src/mcp/server.js:1419`
- Test (existant): `tests/server/mcp-thread-append.test.js`

- [ ] **Step 1:** Run: `npx vitest run tests/server/mcp-thread-append.test.js` — Expected: FAIL ×4, `handleThreadAppend is not a function` (le test importe `{ handleThreadAppend }` de `src/mcp/server.js`, qui n'exporte que `buildServer`, `server`, `getRegisteredToolNames`).

- [ ] **Step 2:** À la ligne 1419 de `src/mcp/server.js` :

```js
// avant
async function handleThreadAppend({ raw_text, role, telegram_message_id }) {
// après
export async function handleThreadAppend({ raw_text, role, telegram_message_id }) {
```

- [ ] **Step 3:** Run: `npx vitest run tests/server/mcp-thread-append.test.js` — Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/server.js
git commit -m "fix(mcp): export handleThreadAppend — répare 4 tests thread_append"
```

### Task 2: Mock db.js du test webhook — ajouter `writeSubjectLink`

**Files:**
- Modify: `tests/server/webhooks-github-merged.test.js:24` (la factory `vi.mock('../../src/server/db.js', …)`)

- [ ] **Step 1:** Run: `npx vitest run tests/server/webhooks-github-merged.test.js` — Expected: FAIL ×4, `expected 500 to be 201` (`src/server/webhooks-github.js:7` importe `writeSubjectLink` depuis db.js ; la factory du mock ne le fournit pas → import undefined → 500 à l'exécution).

- [ ] **Step 2:** Dans la factory du `vi.mock('../../src/server/db.js', () => ({ … }))` à la ligne 24, ajouter une entrée :

```js
  writeSubjectLink: vi.fn(),
```

- [ ] **Step 3:** Run: `npx vitest run tests/server/webhooks-github-merged.test.js` — Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add tests/server/webhooks-github-merged.test.js
git commit -m "test(webhooks): mock db.js complété avec writeSubjectLink — répare 4 tests merge"
```

### Task 3: Fixture `RENDERER_PAYLOAD_TYPES` — 7 → 8

**Files:**
- Modify: `tests/react/chat-renderer-types.test.ts:77-87`
- Modify (si exemple manquant): `apps/chat/lib/chat-renderer-examples.ts:167`

- [ ] **Step 1:** Run: `npx vitest run tests/react/chat-renderer-types.test.ts` — Expected: FAIL, la liste attendue a 7 entrées, `src/packages/chat-renderer/parser.js:14` en a 8 (le type `subject-constellation` a été ajouté sans mettre à jour la fixture).

- [ ] **Step 2:** Mettre à jour le test (et son intitulé, qui dit « seven ») :

```ts
describe('RENDERER_PAYLOAD_TYPES', () => {
  it('lists exactly the eight renderer payload types', () => {
    expect(RENDERER_PAYLOAD_TYPES).toEqual([
      'job-status',
      'console-stream',
      'terminal-session',
      'error-halt',
      'inline-actions',
      'react-canvas',
      'queue-card',
      'subject-constellation',
    ]);
  });
```

- [ ] **Step 3:** Run le fichier. Si « has one example per type » échoue encore : ouvrir la branche `subject-constellation` du validateur dans `src/packages/chat-renderer/parser.js` (elle liste les champs requis), construire l'exemple minimal correspondant et l'ajouter à `ALL_RENDERER_EXAMPLES` dans `apps/chat/lib/chat-renderer-examples.ts` (même forme que les 7 exemples existants du même tableau).

- [ ] **Step 4:** Run: `npx vitest run tests/react/chat-renderer-types.test.ts` — Expected: tout vert.

- [ ] **Step 5: Commit**

```bash
git add tests/react/chat-renderer-types.test.ts apps/chat/lib/chat-renderer-examples.ts
git commit -m "test(chat-renderer): fixture alignée sur les 8 types (subject-constellation)"
```

### Task 4: Suite complète verte + flaky documenté

- [ ] **Step 1:** `npm ci` (élimine la famille « cookie-parser manquant » — le paquet est bien dans `dependencies`, l'échec de l'audit venait d'un node_modules rassis).

- [ ] **Step 2:** Run: `npx vitest run 2>&1 | tail -15`. Chaque échec restant appartient à l'une des trois familles ci-dessus — appliquer le même pattern. Cas connu à part : `tests/worker/bootstrap-project.test.js` timeout **uniquement en suite complète** (flaky documenté en mémoire studio, pas une vraie régression) → sur son `describe` :

```js
// Flaky en suite complète uniquement (contention I/O git clone) — passe seul.
// Documenté mémoire studio `flaky_bootstrap_test`. Retry 1 le temps du vrai fix.
describe('bootstrap-project', { retry: 1 }, () => {
```

- [ ] **Step 3:** Run: `npx vitest run 2>&1 | tail -3` — Expected: `0 failed` (les 67 skipped existants restent skipped).

- [ ] **Step 4: Commit**

```bash
git add -u tests/
git commit -m "test: suite complète verte — retry documenté sur le flaky bootstrap-project"
```

### Task 5: Le job CI

**Files:**
- Modify: `.github/workflows/pr-checks.yml` (ajouter un job à côté de `conflict-markers`)

- [ ] **Step 1:** Ajouter au niveau de `jobs:` :

```yaml
  tests:
    name: Vitest
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx vitest run
```

- [ ] **Step 2:** Corriger CLAUDE.md (section Commands) — remplacer les deux mensonges :

```bash
npm run build    # dashboard (chat + legacy) + widget
npm test         # vitest run — la suite DOIT être verte, gated en CI (pr-checks.yml)
```

- [ ] **Step 3: Commit + vérifier sur la PR**

```bash
git add .github/workflows/pr-checks.yml CLAUDE.md
git commit -m "ci: vitest gate sur chaque PR + CLAUDE.md véridique (npm test réel)"
```

Pousser ; sur la PR, le check « Vitest » doit apparaître et passer. **Acceptance finale : une PR qui casse un test ne peut plus merger vert.**
