#!/usr/bin/env bash
# Crée (one-shot) ou resette le repo sandbox du bench moteur.
#   ./setup-sandbox.sh create   → gh repo create + push baseline
#   ./setup-sandbox.sh reset    → force-push la baseline sur main (état connu)
# Le reset ferme aussi les PRs du run précédent et supprime leurs branches.
set -euo pipefail
REPO="${BENCH_REPO:-franckbirba/devpanl-bench-sandbox}"
SEED_DIR="$(cd "$(dirname "$0")/sandbox-seed" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

push_baseline() {
  cp -R "$SEED_DIR/." "$WORK/"
  git -C "$WORK" init -q -b main
  git -C "$WORK" add -A   # seed jetable dans un tmpdir — pas le repo dev-panel
  git -C "$WORK" -c user.email=bench@devpanl.dev -c user.name=bench commit -qm "bench baseline"
  git -C "$WORK" remote add origin "git@github.com:$REPO.git"
  git -C "$WORK" push -q --force origin main
}

case "${1:-}" in
  create)
    gh repo view "$REPO" >/dev/null 2>&1 || gh repo create "$REPO" --private
    push_baseline
    echo "sandbox created: $REPO @ baseline"
    ;;
  reset)
    push_baseline
    gh pr list -R "$REPO" --state open --json number -q '.[].number' \
      | xargs -r -I{} gh pr close -R "$REPO" {} --delete-branch
    echo "sandbox reset: $REPO @ baseline"
    ;;
  *) echo "usage: $0 create|reset"; exit 2 ;;
esac
