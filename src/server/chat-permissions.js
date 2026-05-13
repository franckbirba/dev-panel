// Permission gate for destructive chat tools.
//
// Some MCP tools wired into the dashboard chat have visible side effects
// — they cancel running jobs, dispatch work items to the agent fleet,
// promote captures, resolve issues. The current setup runs them
// instantly on the LLM's say-so. When the LLM hallucinates a tool call
// (we've seen Qwen3 fire `cancel_job` with a wrong id mid-conversation),
// there's nothing between the bad call and the real-world effect.
//
// This module inserts a one-step human-in-the-loop confirmation. For any
// tool name in `SENSITIVE_TOOLS`, the first call returns an
// `inline-actions` renderer payload instead of executing. The user sees
// a Confirm / Cancel chip set; clicking Confirm appends a user message
// ("Yes — proceed with X") that prompts the LLM to re-call the same
// tool. The wrapper has marked the (toolName, args) pair as "recently
// asked" with a 60s TTL — the re-call within the window goes through.
//
// Trade-off (intentional, scoped to this v1):
//   - The 60s window is a *grace period* — within it, any caller of the
//     same tool+args bypasses the gate, even without user input. For
//     internal use with one operator at a time this is acceptable. The
//     follow-up tightening would be a strict cryptographic token in the
//     chip payload that the wrapper requires; punted to a later PR.

import crypto from 'crypto';

export const SENSITIVE_TOOLS = new Set([
  'cancel_job',
  'promote_capture',
  'plane_dispatch_work_item',
  'dispatch_work_item',
  'glitchtip_resolve_issue',
]);

const CONFIRMATION_TTL_MS = 60_000;

// Map<`${toolName}::${argsHash}`, expiresAtMs>
const pendingConfirmations = new Map();

function argsHash(args) {
  try {
    const keys = Object.keys(args || {}).sort();
    const stable = keys.reduce((acc, k) => {
      acc[k] = args[k];
      return acc;
    }, {});
    return crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 10);
  } catch {
    return 'unhashable';
  }
}

function rememberAsked(toolName, args) {
  const key = `${toolName}::${argsHash(args)}`;
  pendingConfirmations.set(key, Date.now() + CONFIRMATION_TTL_MS);
}

function consumeIfRecentlyAsked(toolName, args) {
  const key = `${toolName}::${argsHash(args)}`;
  const expiresAt = pendingConfirmations.get(key);
  if (!expiresAt) return false;
  if (Date.now() >= expiresAt) {
    pendingConfirmations.delete(key);
    return false;
  }
  pendingConfirmations.delete(key); // single-use
  return true;
}

function makeConfirmPayload(toolName, args) {
  const summary = (() => {
    try {
      const argEntries = Object.entries(args || {});
      if (argEntries.length === 0) return toolName;
      const argLine = argEntries
        .slice(0, 3)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v).slice(0, 40)}`)
        .join(' ');
      return `${toolName}(${argLine})`;
    } catch {
      return toolName;
    }
  })();

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          type: 'inline-actions',
          prompt: `About to call \`${summary}\`. This has side effects — confirm to proceed.`,
          actions: [
            {
              id: 'confirm',
              label: '✓ Confirm',
              payload: `Yes — proceed with ${toolName}.`,
              variant: 'primary',
            },
            {
              id: 'cancel',
              label: '✕ Cancel',
              payload: `No — skip ${toolName}. Just acknowledge and move on.`,
              variant: 'default',
            },
          ],
        }),
      },
    ],
  };
}

// Wraps an MCP tool definition. If the tool name is in SENSITIVE_TOOLS,
// intercepts execute(): the first call within a 60s window returns an
// inline-actions payload; the second call (after the user clicks Confirm
// and the LLM re-fires the tool) actually executes.
// Non-sensitive tools pass through unchanged.
export function gateToolWithPermission(toolName, tool) {
  if (!SENSITIVE_TOOLS.has(toolName)) return tool;
  if (!tool || typeof tool.execute !== 'function') return tool;

  const originalExecute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (args, ctx) => {
      if (consumeIfRecentlyAsked(toolName, args)) {
        return originalExecute(args, ctx);
      }
      rememberAsked(toolName, args);
      console.log(`[chat-permissions] gated ${toolName} — awaiting user confirmation`);
      return makeConfirmPayload(toolName, args);
    },
  };
}

// Test helper — clears the pending map. Not part of the public API.
export function _resetPendingConfirmationsForTests() {
  pendingConfirmations.clear();
}
