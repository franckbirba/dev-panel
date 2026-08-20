#!/usr/bin/env bash
# scripts/local-stack.sh — stack de développement locale, sans l'infra prod.
#
# Monte Redis + Postgres(pgvector) sur des ports décalés, applique les
# migrations, et écrit .env.local. Objectif : itérer sur le moteur (worker,
# engine, harness, bench) sans dépendre des VPS ni de traefik/oauth/Plane.
#
#   ./scripts/local-stack.sh up      # démarre + migre + écrit .env.local
#   ./scripts/local-stack.sh down    # arrête et supprime les conteneurs
#   ./scripts/local-stack.sh status
#
# Ports décalés volontairement (63790/54320) pour cohabiter avec d'autres
# stacks Docker locales.
set -euo pipefail
cd "$(dirname "$0")/.."

REDIS_NAME=devpanl-local-redis
PG_NAME=devpanl-local-pg
REDIS_PORT=63790
PG_PORT=54320

write_env() {
  cat > .env.local <<EOF
# Généré par scripts/local-stack.sh — stack de dev locale.
# Charger avec: set -a; source .env.local; set +a
REDIS_HOST=127.0.0.1
REDIS_PORT=$REDIS_PORT
PG_HOST=127.0.0.1
PG_PORT=$PG_PORT
PG_USER=devpanl
PG_PASSWORD=devpanl
PG_DATABASE=agent_memory
DEVPANEL_STORAGE=./storage-local
ADMIN_API_KEY=local_admin_key
PORT=3030
NODE_ENV=development
# Les tools SSH n'ont rien à faire en local (invariant ADR-003).
DEVPANEL_SSH_TOOLS=off
# Le puller ne dispatche jamais tout seul en local (contrat §10).
BACKLOG_PULL_MAX_PER_TICK=0
EOF
  echo "→ .env.local écrit"
}

case "${1:-up}" in
  up)
    docker inspect "$REDIS_NAME" >/dev/null 2>&1 \
      || docker run -d --name "$REDIS_NAME" -p "$REDIS_PORT:6379" redis:7-alpine >/dev/null
    docker inspect "$PG_NAME" >/dev/null 2>&1 \
      || docker run -d --name "$PG_NAME" -p "$PG_PORT:5432" \
           -e POSTGRES_USER=devpanl -e POSTGRES_PASSWORD=devpanl -e POSTGRES_DB=agent_memory \
           pgvector/pgvector:pg16 >/dev/null
    docker start "$REDIS_NAME" "$PG_NAME" >/dev/null 2>&1 || true
    echo -n "→ attente de postgres"
    until docker exec "$PG_NAME" pg_isready -U devpanl -q 2>/dev/null; do echo -n "."; sleep 1; done
    echo " ok"
    write_env
    mkdir -p storage-local
    set -a; source .env.local; set +a
    node scripts/migrate.mjs
    echo "→ stack locale prête (redis:$REDIS_PORT, postgres:$PG_PORT)"
    ;;
  down)
    docker rm -f "$REDIS_NAME" "$PG_NAME" >/dev/null 2>&1 || true
    echo "→ stack locale arrêtée"
    ;;
  status)
    docker ps --filter "name=devpanl-local" --format "{{.Names}}\t{{.Status}}\t{{.Ports}}"
    set -a; source .env.local 2>/dev/null; set +a
    node scripts/migrate.mjs --status
    ;;
  *) echo "usage: $0 up|down|status"; exit 2 ;;
esac
