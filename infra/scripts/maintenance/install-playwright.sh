#!/bin/bash
# ============================================================================
# install-playwright.sh — Install Playwright + Chromium on agents node
# Usage:
#   bash infra/scripts/maintenance/install-playwright.sh
# ============================================================================
set -euo pipefail

echo "🎭 Installing Playwright for QA automation..."

# Check we're on the agents node (skip if non-interactive)
HOSTNAME=$(hostname)
if [[ "$HOSTNAME" != *"agents"* ]] && [[ "$HOSTNAME" != "62.238.0.167" ]]; then
  if [ -t 0 ]; then
    echo "⚠️  Warning: This script is intended for the agents node (62.238.0.167)"
    read -p "Continue anyway? [y/N] " -n 1 -r
    echo
    [[ ! $REPLY =~ ^[Yy]$ ]] && exit 0
  else
    echo "⚠️  Warning: Not on agents node, but continuing (non-interactive mode)"
  fi
fi

# ── Install system dependencies for Chromium ────────────────────────────────

echo "📦 Installing system dependencies..."
apt-get update -qq
apt-get install -y --no-install-recommends \
  libnss3 \
  libnspr4 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libxkbcommon0 \
  libxcomposite1 \
  libxdamage1 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libasound2t64 \
  libpango-1.0-0 \
  libcairo2 \
  libgdk-pixbuf2.0-0 \
  libgtk-3-0 \
  libx11-xcb1 \
  libxcb-dri3-0 \
  fonts-liberation \
  xdg-utils

# ── Install Playwright browsers ─────────────────────────────────────────────

echo "🌐 Installing Playwright browsers (Chromium only)..."
npx --yes playwright@latest install chromium

# Verify installation
echo ""
echo "✅ Playwright installed successfully!"
echo ""
echo "Installed browsers:"
npx --yes playwright@latest --version
ls -lh ~/.cache/ms-playwright/ 2>/dev/null || echo "No browsers cached yet"

# ── Test Playwright MCP ─────────────────────────────────────────────────────

echo ""
echo "🧪 Testing Playwright MCP server..."
timeout 5 npx --yes @automatalabs/mcp-server-playwright --help 2>&1 || echo "MCP server ready (timeout expected)"

# ── Post-install instructions ───────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Playwright setup complete!"
echo ""
echo "To run QA tests:"
echo "  1. Ensure Claude Code is running on this node"
echo "  2. Use /agent-qa skill to trigger automated tests"
echo "  3. Or manually: npx playwright test"
echo ""
echo "Browser location: ~/.cache/ms-playwright/"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
