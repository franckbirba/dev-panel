#!/usr/bin/env bash
# scripts/setup-github-webhooks.sh
# Idempotently configure GitHub pull_request webhooks on managed repos.
# Requires: gh CLI authenticated with repo + admin:repo_hook scopes.
#
# Usage:
#   GITHUB_WEBHOOK_SECRET=mysecret ./scripts/setup-github-webhooks.sh
#   # or let it generate one:
#   ./scripts/setup-github-webhooks.sh
set -euo pipefail

WEBHOOK_URL="https://devpanl.dev/api/webhooks/github"
REPOS=("franckbirba/dev-panel" "franckbirba/zeno" "franckbirba/edms")

# Generate or use existing secret
if [ -z "${GITHUB_WEBHOOK_SECRET:-}" ]; then
  GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)
  echo "Generated GITHUB_WEBHOOK_SECRET=$GITHUB_WEBHOOK_SECRET"
  echo "Add this to .env.production on the services VPS."
else
  echo "Using existing GITHUB_WEBHOOK_SECRET from env."
fi

for REPO in "${REPOS[@]}"; do
  echo ""
  echo "--- $REPO ---"

  # Check if hook already exists for this URL
  EXISTING=$(gh api "repos/$REPO/hooks" --jq ".[] | select(.config.url == \"$WEBHOOK_URL\") | .id" 2>/dev/null || true)

  if [ -n "$EXISTING" ]; then
    echo "Hook already exists (id=$EXISTING), skipping."
    continue
  fi

  # Create the webhook
  gh api "repos/$REPO/hooks" \
    -X POST \
    -f 'name=web' \
    -f "config[url]=$WEBHOOK_URL" \
    -f 'config[content_type]=json' \
    -f "config[secret]=$GITHUB_WEBHOOK_SECRET" \
    -f 'config[insecure_ssl]=0' \
    -f 'events[]=pull_request' \
    -F 'active=true'

  echo "Hook created for $REPO."
done

echo ""
echo "Done. Webhook secret (add to .env.production if not already there):"
echo "  GITHUB_WEBHOOK_SECRET=$GITHUB_WEBHOOK_SECRET"
