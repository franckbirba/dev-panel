# Playwright Setup for QA Automation

Complete guide for setting up Playwright on the agents node for automated E2E testing.

## Overview

The QA Agent (`/agent-qa`) uses Playwright MCP to run automated browser tests:
- **Smoke tests** — Fast health checks (<2 min)
- **E2E tests** — Complete user workflows (5-10 min)
- **Visual regression** — Screenshot comparison (10-15 min)

## Prerequisites

**Agents Node (62.238.0.167):**
- Ubuntu 24.04 LTS
- Node.js v22+ with npx
- Claude Code running (Shelly)
- Access to devpanl.dev (for testing)

## Installation

### Automated Setup (Recommended)

```bash
# SSH into agents node
ssh -i ~/.ssh/hetzner-vps root@62.238.0.167

# Run installation script
cd ~/dev-panel
bash infra/scripts/maintenance/install-playwright.sh
```

This installs:
1. System dependencies (libnss3, libatk, libcups, etc.)
2. Playwright npm package
3. Chromium browser binary (~170 MB)

### Manual Setup

```bash
# 1. Install system dependencies
apt-get update
apt-get install -y \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 libgdk-pixbuf2.0-0 libgtk-3-0 \
  libx11-xcb1 libxcb-dri3-0 fonts-liberation xdg-utils

# 2. Install Playwright browsers
npx --yes playwright@latest install chromium

# 3. Verify installation
npx --yes playwright@latest --version
ls -lh ~/.cache/ms-playwright/
```

## MCP Configuration

Playwright MCP is configured in `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@automatalabs/mcp-server-playwright"],
      "note": "Playwright browser automation — run E2E tests, take screenshots, interact with UI"
    }
  }
}
```

**No additional configuration needed** — the MCP server auto-detects installed browsers.

## Testing

### Verify Playwright Works

```bash
# Test browser launch
npx playwright open https://devpanl.dev
# Should open Chromium in headless mode (no GUI)

# Test screenshot capture
npx playwright screenshot https://devpanl.dev screenshot.png
ls -lh screenshot.png
```

### Test Playwright MCP

```bash
# In Claude Code (on agents node)
# Use the Playwright MCP tools:

mcp__playwright__browser_navigate({ url: "https://devpanl.dev" })
mcp__playwright__browser_take_screenshot({ filename: "test.png" })
```

## Running QA Tests

### Via Claude Code Skill

```bash
# In Claude Code session
claude /agent-qa
```

This triggers the full QA workflow:
1. Smoke tests (API health, widget render)
2. E2E tests (bug report submission)
3. Visual regression (screenshot comparison)
4. Report results to Plane
5. Create DevPanel bug tickets for failures

### Via BullMQ Job

```javascript
// Enqueue QA job
await queue.add('qa:run', {
  work_item_id: 'plane-work-item-id',
  pr_number: 123,
  test_suite: 'smoke' // or 'e2e', 'visual', 'all'
})
```

### Manual Playwright Test

```bash
# Create test file
cat > test.spec.js << 'EOF'
const { test, expect } = require('@playwright/test');

test('devpanel homepage loads', async ({ page }) => {
  await page.goto('https://devpanl.dev');
  await expect(page).toHaveTitle(/DevPanel/);
});
EOF

# Run test
npx playwright test test.spec.js --headed
```

## Browser Locations

Playwright stores browser binaries in:
```
~/.cache/ms-playwright/chromium-<version>/chrome-linux/chrome
```

**Size**: ~170 MB per browser (Chromium only)

To check installed browsers:
```bash
npx playwright list-browsers
```

## Troubleshooting

### Issue: Browser Launch Fails

**Error**: `browserType.launch: Executable doesn't exist`

**Fix**:
```bash
npx playwright install chromium
```

### Issue: Missing System Dependencies

**Error**: `error while loading shared libraries: libnss3.so`

**Fix**:
```bash
apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0
```

### Issue: Headless Mode Not Working

**Error**: `Cannot find X display`

**Fix**: Playwright runs headless by default, no X server needed. If error persists:
```bash
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 &
```

### Issue: Permissions Error

**Error**: `EACCES: permission denied, mkdir '/root/.cache/ms-playwright'`

**Fix**:
```bash
mkdir -p ~/.cache/ms-playwright
chmod 755 ~/.cache/ms-playwright
```

## Performance Optimization

### Disk Space

**Before installation**: ~2 GB free
**After installation**: ~170 MB used (Chromium only)

To save space, only install Chromium (not Firefox/WebKit):
```bash
npx playwright install chromium
```

### Memory Usage

**Idle**: ~50 MB (MCP server)
**Active test**: ~200-300 MB (Chromium + page)
**Peak**: ~500 MB (multiple tabs)

Recommended RAM for agents node: **2 GB minimum**

### Test Execution Time

- **Smoke tests**: <2 min (3 scenarios)
- **E2E tests**: 5-10 min (full workflows)
- **Visual regression**: 10-15 min (screenshot comparison)

## Security Considerations

1. **Sandboxing**: Chromium runs in sandbox mode by default
2. **No GUI**: Headless mode only, no X server required
3. **Isolated cache**: Browser profile isolated to `~/.cache/ms-playwright/`
4. **Network access**: Only to devpanl.dev and test URLs

To disable sandbox (not recommended):
```javascript
browser_navigate({
  url: "...",
  browserOptions: { args: ['--no-sandbox'] }
})
```

## Updating Playwright

```bash
# Update to latest version
npx --yes playwright@latest install chromium

# Or pin to specific version
npx --yes playwright@1.50.0 install chromium
```

## Uninstalling

```bash
# Remove Playwright browsers
rm -rf ~/.cache/ms-playwright/

# Remove system dependencies (optional)
apt-get remove -y libnss3 libnspr4 libatk1.0-0 # ...
apt-get autoremove -y
```

## References

- **Playwright Docs**: https://playwright.dev/docs/intro
- **MCP Playwright**: https://github.com/automatalabs/mcp-server-playwright
- **QA Agent Skill**: `.claude/skills/agent-qa.md`
- **Installation Script**: `infra/scripts/maintenance/install-playwright.sh`
