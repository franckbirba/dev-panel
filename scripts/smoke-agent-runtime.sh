#!/usr/bin/env bash
# scripts/smoke-agent-runtime.sh — end-to-end verification of Spec 1
set -euo pipefail

: "${ADMIN_API_KEY:?ADMIN_API_KEY required}"
: "${VOYAGE_API_KEY:?VOYAGE_API_KEY required}"
: "${PG_PASSWORD:?PG_PASSWORD required}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== 1. memory MCP write+search roundtrip =="
node -e "
  (async () => {
    const { embed } = await import('./src/server/voyage.js');
    const { memoryInsert, memorySearchSql, pool } = await import('./src/server/pg.js');
    const e = await embed('smoke test note');
    const id = await memoryInsert({
      namespace: 'dev-panel', agent: 'builder', kind: 'decision',
      title: 'smoke test', content: 'verifying memory layer', embedding: e
    });
    const hits = await memorySearchSql({ namespace: 'dev-panel', embedding: e, limit: 1 });
    if (hits[0].id !== id) { console.error('roundtrip failed'); process.exit(1); }
    console.log('   OK id=' + id);
    await pool.end();
  })();
"

echo "== 2. admin SSE publish+consume =="
( curl -sN -H "X-Admin-Key: $ADMIN_API_KEY" http://localhost:3030/api/admin/events > /tmp/smoke-events.log & echo $! > /tmp/smoke-curl.pid )
sleep 1
curl -s -X POST -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"event":"smoke.test","data":{"ok":true}}' \
  http://localhost:3030/api/admin/events/publish > /dev/null
sleep 1
kill "$(cat /tmp/smoke-curl.pid)" 2>/dev/null || true
if grep -q 'smoke.test' /tmp/smoke-events.log; then echo '   OK'; else echo '   FAIL: event not received'; exit 1; fi

echo "== 3. deploy authorization gate =="
node -e "
  (async () => {
    const { assertAllowedRequester } = await import('./src/worker/auth.js');
    try { assertAllowedRequester('deploy', 'pm'); console.error('should have thrown'); process.exit(1); }
    catch (e) { if (!/not allowed/.test(e.message)) { console.error(e); process.exit(1); } console.log('   OK'); }
  })();
"

echo "== 4. Shelly notifyJob (plain ASCII) =="
SHELLY_DEBOUNCE_MS=0 node -e "
  (async () => {
    const mod = await import('./src/server/alerts.js');
    await mod.notifyJob({
      agent: 'builder', work_item_id: 'wi_smoke', title: 'smoke',
      status: 'done', duration_ms: 1234, extra: '1 commit', next_agent: 'reviewer'
    });
    // Wait for debounce flush
    await new Promise(r => setTimeout(r, 100));
    console.log('   OK (check Telegram for line if SHELLY_TELEGRAM_WEBHOOK set)');
  })();
"

echo
echo 'Smoke test complete. Manual checks still required:'
echo '  - dashboard updated live without refresh during step 2'
echo '  - Shelly Telegram received a DONE line during step 4'
echo '  - agent_job_log populated after a real job dispatch'
