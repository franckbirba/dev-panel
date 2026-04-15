#!/usr/bin/env bash
# scripts/smoke-workflow-engine.sh
#
# End-to-end smoke for the workflow engine.
# Requires: local Redis, writable storage dir, env: ADMIN_API_KEY, REDIS_HOST
# (REDIS_PORT optional). Does NOT need Plane/GitHub/Voyage creds — those
# automation steps no-op without them.
#
# Scenarios:
#   1. Happy path: builder → reviewer → qa → done
#   2. Replan path: qa failed → pm replan done → revision+1 → builder
#
# Strategy: inject synthetic agent stdout via a fake `claude` shim on PATH.

set -euo pipefail

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"
export REDIS_HOST REDIS_PORT
export DEVPANEL_STORAGE="$(mktemp -d)"
export ADMIN_API_KEY="${ADMIN_API_KEY:-smoke-admin-$$}"
export WORKER_EVENTS_URL="http://localhost:3030/api/admin/events/publish"

echo "== Smoke: workflow engine =="
echo "storage:  $DEVPANEL_STORAGE"

# 1. Init DB (runs migrations via initMasterDatabase in-code)
node -e "
import('./src/server/db.js').then(({ initMasterDatabase }) => {
  initMasterDatabase(process.env.DEVPANEL_STORAGE);
  console.log('db ready at', process.env.DEVPANEL_STORAGE);
});
"

# 2. Happy path — dispatch and simulate three agent completions.
node scripts/_smoke-drive.js happy

# 3. Replan path
node scripts/_smoke-drive.js replan

echo "OK"
