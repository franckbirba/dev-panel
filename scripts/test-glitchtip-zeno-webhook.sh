#!/bin/bash

# Script to test GlitchTip → Zeno captures integration
# Usage: ./scripts/test-glitchtip-zeno-webhook.sh [project-id] [secret]

set -e

PROJECT_ID="${1:-demo}"
SECRET="${2:-}"
WEBHOOK_URL="https://devpanl.dev/api/webhooks/glitchtip/${PROJECT_ID}"

echo "Testing GlitchTip webhook integration for project: ${PROJECT_ID}"
echo "Target URL: ${WEBHOOK_URL}"
if [ -n "${SECRET}" ]; then
  echo "With secret: YES"
  WEBHOOK_URL="${WEBHOOK_URL}?secret=${SECRET}"
else
  echo "With secret: NO (will likely fail authentication)"
fi
echo ""

# Generate a test payload similar to what GlitchTip would send
TEST_PAYLOAD=$(cat <<EOF
{
  "action": "created",
  "data": {
    "issue": {
      "id": "test-$(date +%s)",
      "title": "Test error from GlitchTip integration check",
      "culprit": "test-script in scripts/test-glitchtip-zeno-webhook.sh",
      "permalink": "https://glitchtip.devpanl.dev/test/issues/test-error",
      "fingerprint": ["test-glitchtip-integration-$(date +%s)"],
      "metadata": {
        "environment": "testing",
        "exception": {
          "values": [{
            "type": "Error",
            "value": "This is a test error to verify GlitchTip → captures integration",
            "stacktrace": {
              "frames": [
                {
                  "filename": "scripts/test-glitchtip-zeno-webhook.sh",
                  "function": "main",
                  "lineno": 15,
                  "colno": 10
                }
              ]
            }
          }]
        }
      },
      "breadcrumbs": {
        "values": [
          {
            "timestamp": $(date +%s),
            "category": "script",
            "message": "Running integration test"
          }
        ]
      }
    }
  }
}
EOF
)

echo "Sending test payload..."
echo "${TEST_PAYLOAD}" | jq . >/dev/null || { echo "Invalid JSON"; exit 1; }

# Try to send the test payload
echo ""
echo "=== Test: Sending webhook payload ==="
RESPONSE=$(curl -s -w "\\n%{http_code}" \
  -H "Content-Type: application/json" \
  --data-binary "${TEST_PAYLOAD}" \
  "${WEBHOOK_URL}" || echo "Request failed")

HTTP_CODE=$(echo "${RESPONSE}" | tail -n1)
RESPONSE_BODY=$(echo "${RESPONSE}" | head -n -1)

echo "HTTP Status: ${HTTP_CODE}"
echo "Response: ${RESPONSE_BODY}"

if [ "${HTTP_CODE}" = "201" ]; then
  echo "✅ SUCCESS: Capture created successfully!"
elif [ "${HTTP_CODE}" = "200" ]; then
  echo "✅ SUCCESS: Capture processed (possibly deduplicated)"
elif [ "${HTTP_CODE}" = "404" ]; then
  echo "⚠️  WARNING: Project not found - check project ID"
elif [ "${HTTP_CODE}" = "401" ]; then
  echo "⚠️  WARNING: Authentication failed - check secret"
else
  echo "❌ ERROR: Unexpected response"
fi

echo ""
echo "=== Test completed ==="
echo ""
echo "Note: For full integration testing, you need:"
echo "1. Valid project ID (found in projects database)"
echo "2. Valid GLITCHTIP_BRIDGE_HMAC_SECRET"
echo ""
echo "On production server:"
echo "sqlite3 /home/deploy/dev-panel/storage/projects.db \"SELECT id, name FROM projects WHERE name LIKE '%zeno%';\""