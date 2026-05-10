// Capabilities — the single source of truth for what DevPanel exposes.
//
// A Capability is `(intent-shaped MCP tool, single handler, optional render
// component)`. The handler is the canonical implementation that BOTH the
// chat (via the AI SDK + MCP) AND Pi-Shelly (via pi-extensions/capabilities)
// call into. There is no duplicate stitching: if you want Plane work-items
// stitched with their cycle and state group, that lives once in
// `cycle-overview.js#cycleOverview()`.
//
// Why capabilities, not raw MCP tools, are the user-facing surface:
//
//   1. Token cost. A 50-tool MCP server burns ~3-5k tokens per turn just
//      describing the menu. Capabilities collapse 5 raw plane primitives
//      into one intent-shaped verb, slashing the menu.
//   2. LLM drift. With one verb per intent, the model can't pick the
//      "wrong" combination of primitives. Same intent → same path.
//   3. Spec colocation. The Zod description, the handler, and the
//      `renderHint` all live in one file. The chat tool-UI registry
//      (`apps/chat/app/tool-ui-registry.ts`) reads `renderHint` and
//      auto-binds the React card. No fourth doc.
//
// Adding a capability: drop a new file in this directory exporting
// `{ name, description, paramSchema, handler, renderHint? }`, then
// register it in CAPABILITIES below. mcp/server.js + pi-extensions
// pick it up automatically.

import { promoteCapture } from './promote-capture.js';
import { triageInbox } from './triage-inbox.js';
import { cycleOverview } from './cycle-overview.js';
import { workItemDetail } from './work-item-detail.js';
import { fleetStatus } from './fleet-status.js';
import { captureList } from './capture-list.js';
import { captureDetail } from './capture-detail.js';
import { dispatchWorkItem } from './dispatch-work-item.js';
import { tailLogSnapshot } from './tail-log-snapshot.js';
import { runRemoteCheck } from './run-remote-check.js';
import { hostStatus } from './host-status.js';

export const CAPABILITIES = [
  triageInbox,
  cycleOverview,
  workItemDetail,
  fleetStatus,
  captureList,
  captureDetail,
  promoteCapture,
  dispatchWorkItem,
  tailLogSnapshot,
  runRemoteCheck,
  hostStatus,
];

/**
 * Register all capabilities on an MCP server instance. Used both by
 * `src/mcp/server.js` (stdio + remote HTTP transports) and by the
 * pi-extensions/capabilities composite (which re-exposes them under Pi's
 * `defineTool` API).
 */
export function registerCapabilities(server) {
  for (const cap of CAPABILITIES) {
    server.tool(
      cap.name,
      cap.description,
      cap.paramSchema?.shape ?? {},
      async (args) => {
        try {
          const result = await cap.handler(args);
          // Tag every result with the capability name so the chat
          // tool-UI registry can pick the right renderer at stream time
          // without re-keying off tool name.
          const payload = { __capability: cap.name, ...result };
          return {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `${cap.name} failed: ${err.message}` }],
            isError: true,
          };
        }
      }
    );
  }
}

/**
 * Raw MCP tool names the capabilities subsume. Re-exported so
 * pi-extensions/capabilities can declare `__pi_composite_replaces`
 * mechanically — no manual list maintenance.
 */
export const REPLACED_RAW_TOOLS = CAPABILITIES.flatMap((c) => c.replaces ?? []);
