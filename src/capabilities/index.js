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
import { cancelJob } from './cancel-job.js';
import { tailLogSnapshot } from './tail-log-snapshot.js';
import { jobLogSnapshot } from './job-log-snapshot.js';
import { runRemoteCheck } from './run-remote-check.js';
import { hostStatus } from './host-status.js';
import { autoDecisionLog, decisionsLog } from './auto-decisions.js';
import { subjectMap } from './subject-map.js';
import { subjectLink } from './subject-link.js';
import {
  studioAddMember,
  studioListMembers,
  studioAddProject,
  studioListProjects,
} from './onboarding.js';

export const CAPABILITIES = [
  triageInbox,
  cycleOverview,
  workItemDetail,
  fleetStatus,
  captureList,
  captureDetail,
  promoteCapture,
  dispatchWorkItem,
  cancelJob,
  tailLogSnapshot,
  jobLogSnapshot,
  runRemoteCheck,
  hostStatus,
  autoDecisionLog,
  decisionsLog,
  subjectMap,
  subjectLink,
  studioAddMember,
  studioListMembers,
  studioAddProject,
  studioListProjects,
];

/**
 * Register all capabilities on an MCP server instance. Used both by
 * `src/mcp/server.js` (stdio + remote HTTP transports) and by the
 * pi-extensions/capabilities composite (which re-exposes them under Pi's
 * `defineTool` API).
 */
export function registerCapabilities(server) {
  for (const cap of CAPABILITIES) {
    const invoke = async (args) => {
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
    };

    const shape = cap.paramSchema?.shape ?? {};
    server.tool(cap.name, cap.description, shape, invoke);

    // Register each subsumed raw tool name as an alias delegating to the
    // same handler. Qwen3 + other models frequently hallucinate the older
    // names (e.g. `ssh_status`, `tail_log`) from training-data familiarity
    // even when the system prompt lists only the canonical ones. Without
    // aliases those calls 404 at the MCP transport layer ("Load failed").
    //
    // Idempotency: if the raw tool of the same name is *already* declared
    // elsewhere on the server (today: `list_captures` registered directly
    // in `src/mcp/server.js`), registering an alias would throw
    // `Tool <name> is already registered` and abort the entire MCP HTTP
    // mount — leaving `streamText` with zero tools, so Qwen3 fall back to
    // narrating tool names in prose (`[fleet_status()]`) instead of
    // actually calling them. Skip the alias in that case; the original
    // registration wins.
    for (const alias of cap.replaces ?? []) {
      if (alias === cap.name) continue;
      if (server._registeredTools && server._registeredTools[alias]) {
        continue;
      }
      server.tool(
        alias,
        `[alias of ${cap.name}] ${cap.description}`,
        shape,
        invoke
      );
    }
  }
}

/**
 * Raw MCP tool names the capabilities subsume. Re-exported so
 * pi-extensions/capabilities can declare `__pi_composite_replaces`
 * mechanically — no manual list maintenance.
 */
export const REPLACED_RAW_TOOLS = CAPABILITIES.flatMap((c) => c.replaces ?? []);
