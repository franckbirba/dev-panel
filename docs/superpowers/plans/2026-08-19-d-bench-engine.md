# D — Bench d'acceptation du moteur — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** le bench D1–D7 exécutable, en matrice {claude, pi}, contre un repo sandbox jetable — écrit **maintenant** (pendant la Phase A/C) pour servir de TDD au moteur : chaque scénario non encore supporté rapporte `NOT_IMPLEMENTED`, et la barre du go Zeno est « colonne pi entièrement PASS » (arbitrage 2026-08-19 : toutes les épreuves).

**Architecture:** un repo GitHub sandbox (`franckbirba/devpanl-bench-sandbox`) avec une baseline figée re-poussée avant chaque run ; un projet Plane `BENCH` + row projects enregistrée (le chemin de dispatch réel, zéro mock) ; des scénarios déclarés en JSON ; un orchestrateur bash + un assert-helper node qui pilotent tout via l'admin API et `gh`. Le bench N'EST PAS un test vitest — c'est un exercice bout-en-bout de la prod (worker démarré requis), lancé à la main ou par workflow_dispatch, JAMAIS en CI de PR.

**Tech Stack:** bash, node (assert.mjs, fetch vers API_BASE), gh CLI, Plane REST via devpanel admin API.

---

### Task 1: Le repo sandbox et sa baseline

**Files:**
- Create: `scripts/bench/setup-sandbox.sh`
- Create: `scripts/bench/sandbox-seed/` (les fichiers de la baseline, versionnés ICI puis poussés là-bas)

- [ ] **Step 1:** Créer les fichiers seed dans `scripts/bench/sandbox-seed/` :

`package.json` :
```json
{
  "name": "devpanl-bench-sandbox",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run" },
  "devDependencies": { "vitest": "^3.0.0" }
}
```

`src/calc.js` :
```js
export function add(a, b) { return a + b; }
export function mul(a, b) { return a * b; }
```

`tests/calc.test.js` :
```js
import { describe, it, expect } from 'vitest';
import { add, mul } from '../src/calc.js';
describe('calc', () => {
  it('adds', () => expect(add(2, 3)).toBe(5));
  it('muls', () => expect(mul(2, 3)).toBe(6));
});
```

`.devpanlrc.json` :
```json
{
  "project": { "name": "devpanl-bench-sandbox" },
  "commands": { "test": "npx vitest run", "build": "true", "lint": "true" }
}
```

`.gitignore` :
```
node_modules/
.devpanel-worktrees/
```

- [ ] **Step 2:** `scripts/bench/setup-sandbox.sh` — création one-shot + fonction de reset :

```bash
#!/usr/bin/env bash
# Crée (one-shot) ou resette le repo sandbox du bench.
#   ./setup-sandbox.sh create   → gh repo create + push baseline + tag
#   ./setup-sandbox.sh reset    → force-push la baseline sur main (état connu)
set -euo pipefail
REPO="${BENCH_REPO:-franckbirba/devpanl-bench-sandbox}"
SEED_DIR="$(cd "$(dirname "$0")/sandbox-seed" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "${1:-}" in
  create)
    gh repo view "$REPO" >/dev/null 2>&1 || gh repo create "$REPO" --private
    ;&  # fallthrough vers reset pour pousser la baseline
  reset)
    cp -R "$SEED_DIR/." "$WORK/"
    git -C "$WORK" init -q -b main
    git -C "$WORK" add -A
    git -C "$WORK" -c user.email=bench@devpanl.dev -c user.name=bench commit -qm "bench baseline"
    git -C "$WORK" remote add origin "git@github.com:$REPO.git"
    git -C "$WORK" push -q --force origin main
    # Ferme les PRs restantes du run précédent + branches
    gh pr list -R "$REPO" --state open --json number -q '.[].number' \
      | xargs -r -I{} gh pr close -R "$REPO" {} --delete-branch
    echo "sandbox reset: $REPO @ baseline"
    ;;
  *) echo "usage: $0 create|reset"; exit 2 ;;
esac
```

- [ ] **Step 3: Commit**

```bash
git add scripts/bench/setup-sandbox.sh scripts/bench/sandbox-seed/
git commit -m "bench(D): repo sandbox — seed + create/reset"
```

### Task 2: Wiring Plane + projects (one-shot, runbook)

**Files:**
- Create: `scripts/bench/README.md` (le runbook) — contenu ci-dessous, PLUS le fichier d'env.

- [ ] **Step 1:** Exécuter une fois (et documenter dans le README) :
  1. `studio_add_project({ github_url: "https://github.com/franckbirba/devpanl-bench-sandbox", plane_mode: "create", plane_name: "BENCH" })` (MCP devpanel-prod) → noter `project.id`, `plane_project_id`, `api_key`.
  2. Sur l'agents host : vérifier que le bootstrap a cloné `local_path` (sinon `git clone` manuel au chemin retourné).
  3. Créer `scripts/bench/bench.env` (NON commité — ajouté au .gitignore racine) :

```bash
BENCH_REPO=franckbirba/devpanl-bench-sandbox
BENCH_PROJECT_ID=<uuid devpanel>
BENCH_PLANE_PROJECT_ID=<uuid plane>
API_BASE=https://devpanl.dev
ADMIN_API_KEY=<clé>
```

- [ ] **Step 2:** `echo "scripts/bench/bench.env" >> .gitignore` puis commit du README + .gitignore.

### Task 3: Les 7 scénarios déclarés

**Files:**
- Create: `scripts/bench/scenarios.json`

- [ ] **Step 1:** Écrire le fichier — chaque scénario : le work item à créer, les env overrides worker, le prédicat de succès, et `requires` (la capacité moteur qui le rend exécutable — tant qu'elle manque, le runner rapporte `NOT_IMPLEMENTED`) :

```json
{
  "scenarios": [
    {
      "id": "D1", "name": "item simple → PR verte sans intervention",
      "requires": null, "per_driver": true,
      "work_items": [{
        "key": "d1",
        "title": "[BENCH-D1] Ajouter sub(a,b) à src/calc.js avec test",
        "description": "Contexte: calculatrice minimale.\nTravail: ajouter export function sub(a,b) dans src/calc.js et un test 'subs' dans tests/calc.test.js.\nAC: npx vitest run vert, 3 tests.\nFichiers: src/calc.js, tests/calc.test.js.\nDépendances: aucune."
      }],
      "expect": { "instance_state": "completed", "pr_open": true, "pr_ci_green": true }
    },
    {
      "id": "D2", "name": "chaîne de 3 items blocked_by → ordre respecté",
      "requires": "dispatch_wave", "per_driver": true,
      "work_items": [
        { "key": "d2a", "title": "[BENCH-D2a] Créer src/shapes.js avec area(rect)", "description": "Travail: nouveau fichier src/shapes.js exportant areaRect(w,h). Test dédié. AC: vitest vert." },
        { "key": "d2b", "title": "[BENCH-D2b] Ajouter areaCircle dans src/shapes.js", "blocked_by": "d2a", "description": "Travail: étendre src/shapes.js (créé par D2a) avec areaCircle(r). Test. AC: vitest vert." },
        { "key": "d2c", "title": "[BENCH-D2c] Ajouter totalArea() combinant les deux", "blocked_by": "d2b", "description": "Travail: totalArea(shapes[]) utilisant areaRect et areaCircle. Test. AC: vitest vert." }
      ],
      "expect": { "order_by_merge": ["d2a", "d2b", "d2c"], "all_completed": true }
    },
    {
      "id": "D3", "name": "échec propre — classes §4.2, pas de boucle",
      "requires": "failure_taxonomy", "per_driver": true,
      "work_items": [{
        "key": "d3",
        "title": "[BENCH-D3] Corriger le module src/ghost.js",
        "description": "Travail: corriger le bug de src/ghost.js (ce fichier N'EXISTE PAS — le scénario vérifie que l'agent rend blocked proprement au lieu de fabuler ou boucler). AC: impossible par construction."
      }],
      "expect": { "instance_state_in": ["awaiting_input", "failed"], "max_agent_runs": 2, "notified": true }
    },
    {
      "id": "D4", "name": "timeout + budget → kill + rescue",
      "requires": "timeout_budget", "per_driver": true,
      "env": { "BUDGET_TOKENS_BUILDER": "4000", "AGENT_TIMEOUT_BUILDER_MS": "240000" },
      "work_items": [{
        "key": "d4",
        "title": "[BENCH-D4] Documenter exhaustivement chaque ligne du projet",
        "description": "Travail: JSDoc exhaustive de tous les fichiers, analyse détaillée ligne par ligne (volontairement surdimensionné pour un budget de 4k tokens). AC: larges."
      }],
      "expect": { "instance_state": "failed", "reason_in": ["budget", "timeout", "stall"], "rescue_pr_if_diff": true }
    },
    {
      "id": "D5", "name": "cancel distant mid-run", "requires": "worker_control_cancel", "per_driver": false,
      "work_items": [{ "key": "d5", "title": "[BENCH-D5] Renommer add en sum partout", "description": "Travail: renommage add→sum dans src et tests. AC: vitest vert." }],
      "action_mid_run": "cancel",
      "expect": { "instance_state": "cancelled", "no_process_leak": true, "worktree_reclaimed": true }
    },
    {
      "id": "D6", "name": "kill -9 du worker → réconciliation au boot", "requires": "boot_reconciliation", "per_driver": false,
      "work_items": [{ "key": "d6", "title": "[BENCH-D6] Ajouter pow(a,b) avec test", "description": "Travail: export pow dans src/calc.js + test. AC: vitest vert." }],
      "action_mid_run": "kill_worker",
      "expect": { "no_zombie_instances": true, "no_double_dispatch": true, "job_terminal_with_reason": "worker_restart" }
    },
    {
      "id": "D7", "name": "convergence de boucle", "requires": "graph_loops", "per_driver": true,
      "work_items": [{
        "key": "d7",
        "title": "[BENCH-D7] Faire passer le test rouge planté",
        "description": "Le reset D7 plante un test rouge (tests/planted.test.js attend div(a,b) inexistant). Travail: implémenter div pour rendre la suite verte. AC: vitest vert — exige la boucle interne test→fix (H9)."
      }],
      "pre": "plant_failing_test",
      "expect": { "instance_state": "completed", "loop_exited_by": "until", "iterations_lte": 3 }
    }
  ]
}
```

- [ ] **Step 2: Commit** — `git add scripts/bench/scenarios.json && git commit -m "bench(D): les 7 scénarios déclarés"`

### Task 4: `assert.mjs` — les prédicats

**Files:**
- Create: `scripts/bench/assert.mjs`

- [ ] **Step 1:** Implémenter les helpers (tous via `API_BASE` + `ADMIN_API_KEY` + `gh`) :

```js
// scripts/bench/assert.mjs — helpers d'assertion du bench.
// Usage: node assert.mjs <fn> <jsonArgs> ; exit 0 = pass, 1 = fail, 3 = timeout.
const API = process.env.API_BASE;
const KEY = process.env.ADMIN_API_KEY;
const H = { 'X-Admin-Key': KEY, 'content-type': 'application/json' };

async function api(path) {
  const r = await fetch(`${API}${path}`, { headers: H });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export async function waitForInstanceState({ work_item_id, states, timeoutMs = 900_000 }) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const rows = await api(`/api/admin/workflow-instances?work_item_id=${work_item_id}`);
    const st = rows[0]?.status;
    if (states.includes(st)) return st;
    if (['failed', 'exhausted', 'cancelled', 'completed'].includes(st) && !states.includes(st)) {
      throw new Error(`terminal inattendu: ${st} (attendu: ${states})`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  process.exitCode = 3;
  throw new Error(`timeout en attendant ${states} sur ${work_item_id}`);
}

export async function assertPrForBranchPrefix({ repo, prefix, expectOpen = true }) {
  const { execSync } = await import('node:child_process');
  const out = execSync(`gh pr list -R ${repo} --state all --json headRefName,state,number`, { encoding: 'utf8' });
  const pr = JSON.parse(out).find((p) => p.headRefName.startsWith(prefix));
  if (expectOpen && !pr) throw new Error(`aucune PR avec préfixe ${prefix}`);
  return pr;
}

// CLI: node assert.mjs waitForInstanceState '{"work_item_id":"…","states":["completed"]}'
const [, , fn, args] = process.argv;
if (fn) {
  const mod = { waitForInstanceState, assertPrForBranchPrefix };
  mod[fn](JSON.parse(args || '{}'))
    .then((r) => { console.log(JSON.stringify(r)); })
    .catch((e) => { console.error(String(e)); process.exitCode ||= 1; });
}
```

Note : si `/api/admin/workflow-instances?work_item_id=` n'existe pas encore côté API, l'ajouter fait partie de ce task (lecture seule, admin-keyed — 10 lignes dans les routes admin, même pattern que `by-plane-id`).

- [ ] **Step 2: Commit** — `git add scripts/bench/assert.mjs && git commit -m "bench(D): assert helpers (instances + PRs)"`

### Task 5: L'orchestrateur

**Files:**
- Create: `scripts/bench-engine.sh`

- [ ] **Step 1:** Implémenter — boucle matrice × scénarios, avec `NOT_IMPLEMENTED` propre :

```bash
#!/usr/bin/env bash
# Bench d'acceptation du moteur — engine-contract §11.
# usage: ./scripts/bench-engine.sh [--driver claude|pi|all] [--only D1,D2]
# Prérequis: bench.env rempli, worker démarré, scripts/bench/setup-sandbox.sh create déjà fait.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/bench/bench.env
DRIVERS="${2:-claude pi}"; ONLY="${4:-}"
REPORT="storage/bench/$(date +%Y%m%d-%H%M%S)"; mkdir -p "$REPORT"

# Capacités moteur présentes — pilotées par bench.env (IMPLEMENTED_CAPS="dispatch_wave failure_taxonomy …").
has_cap() { [[ " ${IMPLEMENTED_CAPS:-} " == *" $1 "* ]]; }

run_scenario() { # $1=id $2=driver
  local id="$1" driver="$2"
  local req; req=$(jq -r ".scenarios[] | select(.id==\"$id\") | .requires" scripts/bench/scenarios.json)
  if [[ "$req" != "null" ]] && ! has_cap "$req"; then
    echo "{\"scenario\":\"$id\",\"driver\":\"$driver\",\"result\":\"NOT_IMPLEMENTED\",\"missing\":\"$req\"}"
    return 0
  fi
  bash scripts/bench/setup-sandbox.sh reset
  # 1. créer les work items du scénario dans Plane (API admin) + relations blocked_by
  # 2. exporter les env overrides du scénario vers le worker (fichier EnvironmentFile + restart)
  # 3. dispatcher (item seul → dispatch_work_item ; chaîne → dispatch_wave)
  # 4. action_mid_run éventuelle (cancel / kill_worker) déclenchée sur événement 'running'
  # 5. node scripts/bench/assert.mjs selon .expect
  node scripts/bench/run-scenario.mjs --id "$id" --driver "$driver" --report "$REPORT"
}

for d in $DRIVERS; do
  for s in $(jq -r '.scenarios[].id' scripts/bench/scenarios.json); do
    [[ -n "$ONLY" && ",$ONLY," != *",$s,"* ]] && continue
    per_driver=$(jq -r ".scenarios[] | select(.id==\"$s\") | .per_driver" scripts/bench/scenarios.json)
    [[ "$per_driver" == "false" && "$d" != "claude" ]] && continue  # D5/D6: une seule exécution
    run_scenario "$s" "$d" | tee -a "$REPORT/results.jsonl"
  done
done

node scripts/bench/report.mjs "$REPORT/results.jsonl" > "$REPORT/summary.md"
cat "$REPORT/summary.md"
```

`run-scenario.mjs` et `report.mjs` implémentent les étapes 1–5 du commentaire (création d'items via l'admin API — même client fetch que `assert.mjs` —, dispatch via les tools MCP HTTP, matrice de verdicts PASS/FAIL/NOT_IMPLEMENTED en tableau markdown). Chacun ~100 lignes, écrits dans ce task avec le même style que `assert.mjs`.

- [ ] **Step 2:** Premier run réel (worker démarré, `IMPLEMENTED_CAPS=""`) : `./scripts/bench-engine.sh --only D1` → attendu aujourd'hui : `D1 = PASS ou FAIL selon l'état du moteur`, D2–D7 = `NOT_IMPLEMENTED`. **Le bench existe avant le moteur — c'est son TDD.**

- [ ] **Step 3: Commit** — `git add scripts/bench-engine.sh scripts/bench/run-scenario.mjs scripts/bench/report.mjs && git commit -m "bench(D): orchestrateur matrice {claude,pi} × D1-D7"`

### Task 6: Règles d'usage (dans scripts/bench/README.md)

- [ ] Documenter : (1) le bench tourne à la main ou par `workflow_dispatch`, jamais en CI de PR ; (2) **go Zeno = colonne pi entièrement PASS, zéro NOT_IMPLEMENTED, zéro FAIL** (arbitrage 2026-08-19) ; (3) avant chaque relight de prod : re-run complet = non-régression ; (4) chaque évolution majeure du harness : re-run D1 avec un second modèle plancher (DeepSeek) — le canary anti-overfit de l'ADR-004.
