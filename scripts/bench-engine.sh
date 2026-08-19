#!/usr/bin/env bash
# Bench d'acceptation du moteur — engine-contract §11 (matrice {claude, pi} × D1–D7).
#
# usage: ./scripts/bench-engine.sh [--driver claude|pi|all] [--only D1,D3]
#
# Prérequis :
#   - scripts/bench/bench.env rempli (copie de bench.env.example)
#   - devpanel-worker DÉMARRÉ sur l'agents host (le bench exerce la prod réelle)
#   - scripts/bench/setup-sandbox.sh create déjà exécuté une fois
#
# Verdicts par scénario : PASS · FAIL · NOT_IMPLEMENTED (capacité moteur absente,
# pilotée par IMPLEMENTED_CAPS dans bench.env) · CHECK_SKIPPED · RUNNER_ERROR.
# Règle de go (arbitrage 2026-08-19) : GO Zeno = colonne pi entièrement PASS.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/bench/bench.env

DRIVERS="claude pi"
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --driver) [[ "$2" == "all" ]] && DRIVERS="claude pi" || DRIVERS="$2"; shift 2 ;;
    --only)   ONLY="$2"; shift 2 ;;
    *) echo "arg inconnu: $1"; exit 2 ;;
  esac
done

REPORT="storage/bench/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$REPORT"
echo "report dir: $REPORT"

has_cap() { [[ " ${IMPLEMENTED_CAPS:-} " == *" $1 "* ]]; }

for d in $DRIVERS; do
  for s in $(jq -r '.scenarios[].id' scripts/bench/scenarios.json); do
    if [[ -n "$ONLY" && ",$ONLY," != *",$s,"* ]]; then continue; fi
    per_driver=$(jq -r ".scenarios[] | select(.id==\"$s\") | .per_driver" scripts/bench/scenarios.json)
    # D5/D6 sont driver-agnostiques : une seule exécution (colonne claude).
    if [[ "$per_driver" == "false" && "$d" != "claude" ]]; then continue; fi

    req=$(jq -r ".scenarios[] | select(.id==\"$s\") | .requires" scripts/bench/scenarios.json)
    if [[ "$req" != "null" ]] && ! has_cap "$req"; then
      echo "{\"scenario\":\"$s\",\"driver\":\"$d\",\"result\":\"NOT_IMPLEMENTED\",\"missing\":\"$req\"}" \
        | tee -a "$REPORT/results.jsonl"
      continue
    fi

    echo "=== $s × $d ==="
    bash scripts/bench/setup-sandbox.sh reset
    # Le driver du builder pour ce run — repose sur DRIVER_BUILDER lu par le
    # worker. L'application côté worker (EnvironmentFile + restart) est le
    # geste opérateur documenté dans scripts/bench/README.md §Overrides.
    BENCH_DRIVER="$d" node scripts/bench/run-scenario.mjs --id "$s" --driver "$d" --report "$REPORT" \
      | tee -a "$REPORT/results.jsonl"
  done
done

node scripts/bench/report.mjs "$REPORT/results.jsonl" > "$REPORT/summary.md"
echo ""
cat "$REPORT/summary.md"
