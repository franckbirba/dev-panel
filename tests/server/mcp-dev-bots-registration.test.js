// Boot src/mcp/server.js in the internal profile and assert the 4 dev-bots
// admin tools are registered. Pinned separately from the broader public-
// profile test because (a) the public-profile boot is in a different test
// file and ESM modules cache per-worker, and (b) a registration regression
// is the most likely silent failure for these tools — an import typo would
// drop them without crashing anything else.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('src/mcp/server.js boot — dev-bots admin tools', () => {
  it('registers pair_dev_bot, list_dev_bots, revoke_dev_bot, list_dev_bot_allowlist in the internal profile', async () => {
    delete process.env.MCP_PROFILE;
    process.env.MCP_NO_AUTOSTART = '1';
    process.env.DEVPANEL_STORAGE = mkdtempSync(join(tmpdir(), 'mcp-devbots-'));
    delete process.env.PLANE_SHELLY_EMAIL;

    const mod = await import('../../src/mcp/server.js');
    const names = mod.getRegisteredToolNames();
    for (const t of ['pair_dev_bot', 'list_dev_bots', 'revoke_dev_bot', 'list_dev_bot_allowlist']) {
      expect(names, `expected ${t} to be registered in internal profile`).toContain(t);
    }
  });
});
