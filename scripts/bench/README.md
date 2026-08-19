# Bench d'acceptation du moteur

Implémente `engine-contract.md §11` : la matrice **D1–D7 × {claude (référence), pi (plancher)}**. Le bench exerce la **prod réelle** (dispatch → worker → PR sur un repo sandbox) — zéro mock. Il existe **avant** que le moteur soit fini : chaque scénario dont la capacité manque rapporte `NOT_IMPLEMENTED` (piloté par `IMPLEMENTED_CAPS` dans `bench.env`) — c'est le TDD du moteur.

## Règles d'usage

1. **Jamais en CI de PR.** Le bench se lance à la main (ou par `workflow_dispatch`) : il consomme des tokens et exige un worker démarré.
2. **Go Zeno = colonne pi entièrement PASS — zéro NOT_IMPLEMENTED, zéro FAIL** (arbitrage Franck 2026-08-19 : « à partir de toutes les épreuves »). `report.mjs` imprime le verdict GO/NO-GO.
3. **Avant chaque relight de prod** : re-run complet = test de non-régression du moteur.
4. **Canary anti-overfit** (ADR-004) : à chaque évolution majeure du harness, re-run D1 avec un second modèle plancher (DeepSeek) — détecte une accommodation Qwen-spécifique.

## Setup one-shot

1. `cp scripts/bench/bench.env.example scripts/bench/bench.env` puis remplir.
2. `bash scripts/bench/setup-sandbox.sh create` — crée `devpanl-bench-sandbox` (privé) et pousse la baseline.
3. Enregistrer le projet : MCP `studio_add_project({ github_url: "https://github.com/franckbirba/devpanl-bench-sandbox", plane_mode: "create", plane_name: "BENCH" })` → reporter `project.id` et `plane_project_id` dans `bench.env`.
4. Vérifier le clone agents-host à `local_path` (le bootstrap le fait si le worker tourne ; sinon `git clone` manuel).

## Lancer

```bash
./scripts/bench-engine.sh                  # matrice complète
./scripts/bench-engine.sh --driver pi      # colonne plancher seule
./scripts/bench-engine.sh --only D1,D3     # sous-ensemble
```

Rapport : `storage/bench/<timestamp>/summary.md` (+ `results.jsonl`, un JSON détaillé par scénario).

## Overrides worker par scénario (D4…)

Les scénarios avec un bloc `env` (ex. D4 : `BUDGET_TOKENS_BUILDER=4000`) exigent que l'unité `devpanel-worker` lise `EnvironmentFile=-/home/deploy/.bench-overrides.env` — câblage livré avec C2. D'ici là, ces scénarios restent gated par `IMPLEMENTED_CAPS` de toute façon.

## Première exécution live — points à valider

- La shape exacte de l'API relations Plane (`POST /issues/:id/relations/`, payload `{relation_type, issues}`) est écrite d'après la doc publique — à confirmer au premier run D2 et corriger `run-scenario.mjs` si besoin.
- Le préfixe de branche des PRs (`feat/wi-<8 premiers chars de l'UUID>`) suit la convention actuelle de `worktree.js` — si elle évolue, ajuster `runChecks`.
- Checks marqués `CHECK_SKIPPED — observable après C2/C8` : deviennent des vrais checks quand l'engine expose reason/itérations (les brancher fait partie de C2/C8, pas du bench).
