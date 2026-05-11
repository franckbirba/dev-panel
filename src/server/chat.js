import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { streamText, stepCountIs, convertToModelMessages } from 'ai';
import { resolveChatModel } from './chat-providers.js';
import { makeTextScrubber } from './chat-text-scrubber.js';

// Default system prompt — nudges the LLM toward intent-shaped capability
// tools (the ones in `src/capabilities/`) rather than fishing through the
// raw plumbing (`list_captures` → 5 plane primitives → manual stitch).
// Capabilities are 1:1 with React cards via `apps/chat/lib/tool-ui-registry`,
// so calling the right verb makes the chat render a rich card. Calling the
// wrong primitive surfaces JSON via ToolFallback. Both work; the first is
// what you want.
const TOOL_GUIDANCE = `You have access to **capabilities** — intent-shaped tools that wrap multi-step workflows into one verb. Prefer them over the raw plumbing they replace:

- triage_inbox          — captures pending review (replaces list_captures)
- capture_list          — drill-down on captures with filters
- capture_detail        — single capture by uuid (use this when an action targets a specific capture)
- work_item_detail      — Plane work item by sequence id ("DEVPA-209") or UUID
- cycle_overview        — cycle progress + work items (replaces list_cycles + list_cycle_work_items)
- fleet_status          — live BullMQ jobs (queued/running/blocked/etc)
- promote_capture       — promote a capture into a Plane work item (atomic stitch)
- dispatch_work_item    — hand a work item to the agent fleet
- tail_log_snapshot     — last N lines of journalctl on a known host
- run_remote_check      — whitelisted health check on a remote host
- host_status           — load + memory + container snapshot for a host

Each capability returns shape that the chat renders as a rich card automatically. **Call the most specific capability you have.** Do not stitch raw plumbing tools together for a workflow that already has a capability.

Be concise. Don't restate the data the card already shows; add the *insight* (e.g. "3 captures from Zeno today, mostly UI bugs — promote ZENO-42 first?"). When the user asks for status, surface the answer first then the source.`;

const IDENTITY_PROMPTS = {
  deepinfra: 'You are Qwen3-Coder 480B by Alibaba.',
  openai: 'You are GPT-4o by OpenAI.',
  anthropic: 'You are Claude by Anthropic.',
  ollama: 'You are a local model running via Ollama.',
};

function buildSystem(provider) {
  const identity = IDENTITY_PROMPTS[provider] ?? IDENTITY_PROMPTS.deepinfra;
  return `You are the DevPanel assistant for Franck's solo-with-agents studio. You speak French by default (Franck is French) but follow the user's language.

${identity}

${TOOL_GUIDANCE}`;
}

let mcpClient = null;
let cachedMCPTools = null;

async function getMCPTools() {
  if (cachedMCPTools) return cachedMCPTools;

  const url = process.env.DEVPANEL_MCP_URL ?? 'https://devpanl.dev/mcp';
  const token = process.env.ADMIN_API_KEY;
  if (!token) {
    console.warn('[chat] ADMIN_API_KEY missing — MCP tools disabled');
    return {};
  }

  try {
    mcpClient = await createMCPClient({
      transport: {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    cachedMCPTools = await mcpClient.tools();
    return cachedMCPTools;
  } catch (e) {
    console.warn('[chat] MCP connect failed:', e.message);
    return {};
  }
}

export function mountChat(app) {
  app.post('/api/chat', async (req, res) => {
    try {
      const { messages, system, tools } = req.body ?? {};
      const mcpTools = await getMCPTools();
      const { model } = resolveChatModel(req.get('x-devpanl-provider'));

      const result = streamText({
        model,
        messages: await convertToModelMessages(messages ?? []),
        system: system ?? DEFAULT_SYSTEM,
        tools: { ...mcpTools },
        stopWhen: stepCountIs(8),
        experimental_transform: makeTextScrubber,
      });

      // Pipe AI SDK Data Stream Protocol response straight to Express
      const response = result.toUIMessageStreamResponse({ sendReasoning: true });
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      console.error('[chat] handler error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    }
  });
}
