// external-mcp.js — Extra MCP servers the dashboard chat connects to so
// Qwen-in-devpanl sees the same surface as Shelly-in-Telegram.
//
// Shelly's ~/.mcp.json on the agents host lists:
//   - devpanel-mcp   (already covered by the remote HTTP at devpanl.dev/mcp)
//   - affine-zeno    (npx affine-mcp-server@1.13.0)
//   - affine-devpanl (same package, different AFFINE_WORKSPACE_ID)
//   - affine-edms    (same package, different AFFINE_WORKSPACE_ID)
//   - github-mcp     (npx @modelcontextprotocol/server-github)
//   - playwright     (npx @playwright/mcp@latest)            ← out of scope
//   - telegram       (Shelly-only)                            ← out of scope
//   - plane-mcp      (uvx plane-mcp-server)                   ← shadowed by devpanel-prod
//
// We connect to AFFiNE × 3 + GitHub here (stdio child processes inside the
// `devpanel-api` container) and merge their tools into the AI SDK tool
// surface alongside the devpanel-prod HTTP MCP. Each tool is namespaced
// with the server label so name collisions can't happen ("affine_zeno_*",
// "affine_devpanl_*", "affine_edms_*", "github_*").
//
// Failure isolation: if one connector fails to start (npx download
// timeout, missing env, …), the rest still surface. We never throw out of
// `connectExternalMCPs` — partial tool maps + a console.warn are the
// failure mode, same as the existing devpanel-prod connector.
//
// Lifecycle: connectors are cached for the process lifetime, same as the
// existing `cachedMCPTools`. The Express server is a long-running process,
// stdio MCPs amortize the startup cost across all requests.

import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';

const AFFINE_BASE_URL =
  process.env.AFFINE_BASE_URL || 'https://affine.devpanl.dev';
const AFFINE_API_TOKEN = process.env.AFFINE_API_TOKEN || '';
const AFFINE_WS_ZENO =
  process.env.AFFINE_WORKSPACE_ZENO ||
  '493b099b-636a-4b5c-a445-9f7f50f8b5fe';
const AFFINE_WS_DEVPANL =
  process.env.AFFINE_WORKSPACE_DEVPANL ||
  '5e5ba17d-aaab-44f0-9318-51a91f0583d4';
const AFFINE_WS_EDMS =
  process.env.AFFINE_WORKSPACE_EDMS ||
  '0b917070-e240-4a29-8e12-a19c753af472';
const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '';

// Each entry: { label, command, args, env, requiredEnvKey }.
// `requiredEnvKey` short-circuits the spawn when the env isn't wired — the
// container would otherwise spend a minute downloading npx packages just
// to fail with "AFFINE_API_TOKEN missing".
function externalMCPDefs() {
  /** @type {Array<{label:string,command:string,args:string[],env:Record<string,string>,requiredEnvKey?:string,requiredEnvValue?:string}>} */
  const defs = [];
  // The MCP servers are installed as npm deps (see package.json) — we
  // call `npx --no-install` so npm won't try to fetch them at first use
  // (the chat container runs as the non-root `node` user with a
  // read-only HOME; npm fetch would hang).
  if (AFFINE_API_TOKEN) {
    defs.push(
      {
        label: 'affine_zeno',
        command: 'npx',
        args: ['--no-install', 'affine-mcp'],
        env: {
          AFFINE_BASE_URL,
          AFFINE_API_TOKEN,
          AFFINE_WORKSPACE_ID: AFFINE_WS_ZENO,
        },
      },
      {
        label: 'affine_devpanl',
        command: 'npx',
        args: ['--no-install', 'affine-mcp'],
        env: {
          AFFINE_BASE_URL,
          AFFINE_API_TOKEN,
          AFFINE_WORKSPACE_ID: AFFINE_WS_DEVPANL,
        },
      },
      {
        label: 'affine_edms',
        command: 'npx',
        args: ['--no-install', 'affine-mcp'],
        env: {
          AFFINE_BASE_URL,
          AFFINE_API_TOKEN,
          AFFINE_WORKSPACE_ID: AFFINE_WS_EDMS,
        },
      },
    );
  } else {
    console.warn(
      '[external-mcp] AFFINE_API_TOKEN missing — AFFiNE MCPs disabled',
    );
  }

  if (GITHUB_TOKEN) {
    defs.push({
      label: 'github',
      command: 'npx',
      args: ['--no-install', 'mcp-server-github'],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN,
      },
    });
  } else {
    console.warn(
      '[external-mcp] GITHUB_TOKEN missing — GitHub MCP disabled',
    );
  }

  return defs;
}

// Connect one stdio MCP server and return its tools, namespaced by label.
// Returns an empty object on any failure — caller merges across all
// connectors, so one bad server can't poison the whole tool map.
async function connectOne(def) {
  // The Node child_process spawned by StdioMCPTransport inherits *no* env
  // by default (the SDK passes our object verbatim). Some MCP servers need
  // PATH (to find their own node/npx), HOME (npm cache dir), etc. Merge
  // the parent's env so npx can resolve packages.
  const envWithDefaults = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '/tmp',
    npm_config_cache: process.env.npm_config_cache || '/tmp/.npm',
    ...def.env,
  };
  try {
    const client = await createMCPClient({
      transport: new StdioMCPTransport({
        command: def.command,
        args: def.args,
        env: envWithDefaults,
        stderr: 'pipe',
      }),
    });
    const tools = await client.tools();
    const namespaced = Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [
        `${def.label}_${name}`,
        tool,
      ]),
    );
    console.log(
      `[external-mcp] ${def.label}: ${Object.keys(namespaced).length} tools`,
    );
    return { client, tools: namespaced };
  } catch (err) {
    console.warn(`[external-mcp] ${def.label} failed:`, err.message);
    return { client: null, tools: {} };
  }
}

let cached = null;

/**
 * Connect every external MCP server defined above, return a merged tool map
 * keyed by `<server>_<tool_name>`. Cached for the lifetime of the process —
 * stdio MCPs are long-running children, no need to respawn per request.
 *
 * Disable everything: `DISABLE_EXTERNAL_MCP=1` env. Useful for local dev
 * where you don't want npx network traffic on every server boot.
 */
export async function connectExternalMCPs() {
  if (cached) return cached;
  if (process.env.DISABLE_EXTERNAL_MCP === '1') {
    cached = {};
    return cached;
  }
  const defs = externalMCPDefs();
  if (defs.length === 0) {
    cached = {};
    return cached;
  }
  const results = await Promise.all(defs.map(connectOne));
  const merged = {};
  for (const { tools } of results) {
    Object.assign(merged, tools);
  }
  cached = merged;
  return cached;
}
