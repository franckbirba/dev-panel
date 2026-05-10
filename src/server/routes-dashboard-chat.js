// Dashboard chat — SSO-gated thread persistence for the chat-first surface.
//
// Why this exists: `/api/chat` is stateless (request-scoped streamText)
// and lives behind the m2m router so the widget + workers can hit it. The
// browser-side chat needs *durable* threads — context that survives page
// reloads and propagates across tabs. That requires Google-SSO identity,
// which lives behind the SPA-bootstrap router.
//
// Design:
//   - Each SSO user gets a single freeform thread keyed
//     (subject_type='dashboard', subject_id=<email>). Per-subject threads
//     (capture/<uuid>, work_item/<id>, etc.) come later via DEVPA-204 — the
//     chat sidebar's threadlist will let the user pick one.
//   - GET /api/dashboard/chat/history → past messages, seed for useChatRuntime
//   - POST /api/dashboard/chat/turn → wraps streamText, persists user msg
//     before streaming + assistant reply on finish. The browser sees the
//     same AI SDK Data Stream Protocol as /api/chat.
//   - Auth: requireForwardedUser (X-Forwarded-User from Traefik). The
//     traefik label for /api/dashboard/* MUST go through oauth-google.
//
// Why not just persist inside /api/chat: that route serves widget callers
// and workers too — neither has SSO identity. Splitting the surface keeps
// the widget path stateless and gives the browser its own durable lane.

import express from 'express';
import { createOpenAI } from '@ai-sdk/openai';
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { streamText, stepCountIs, convertToModelMessages } from 'ai';
import {
  getOrCreateThread,
  listMessages,
  appendMessage,
} from './threads.js';
import { requireForwardedUser } from './middleware/require-forwarded-user.js';

const PROVIDER = process.env.LLM_PROVIDER ?? 'deepinfra';
const MODEL = process.env.LLM_MODEL ?? (PROVIDER === 'openai'
  ? 'gpt-4o'
  : 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo');

const provider = createOpenAI({
  apiKey: PROVIDER === 'deepinfra'
    ? (process.env.DEEPINFRA_API_KEY ?? process.env.OPENAI_API_KEY)
    : process.env.OPENAI_API_KEY,
  baseURL: PROVIDER === 'deepinfra'
    ? 'https://api.deepinfra.com/v1/openai'
    : undefined,
});

// Reuse the same DEFAULT_SYSTEM as /api/chat. Duplicated rather than
// imported so this module can evolve its prompt independently if Franck
// wants the persisted-thread chat to behave differently from the widget.
const DEFAULT_SYSTEM = `You are the DevPanel assistant for Franck's solo-with-agents studio. You speak French by default (Franck is French) but follow the user's language.

You have access to **capabilities** — intent-shaped tools that wrap multi-step workflows into one verb. Prefer them over the raw plumbing they replace:

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

// Single MCP client per process — same pattern as src/server/chat.js.
let mcpClient = null;
let cachedMCPTools = null;

async function getMCPTools() {
  if (cachedMCPTools) return cachedMCPTools;
  const url = process.env.DEVPANEL_MCP_URL ?? 'https://devpanl.dev/mcp';
  const token = process.env.ADMIN_API_KEY;
  if (!token) {
    console.warn('[dashboard-chat] ADMIN_API_KEY missing — MCP tools disabled');
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
    console.warn('[dashboard-chat] MCP connect failed:', e.message);
    return {};
  }
}

// Map our DB-row shape to assistant-ui's UIMessage shape. Stored
// `content` is plain text (no parts). The runtime expects parts; we wrap
// each row as a single text part. role is normalized:
//   - 'user'   → 'user'
//   - 'shelly' → 'assistant'  (the chat presents Shelly as the assistant)
//   - other    → 'system'      (system / tool — not surfaced for now)
function rowsToUIMessages(rows) {
  return rows.map((row) => ({
    id: String(row.id),
    role:
      row.role === 'user'
        ? 'user'
        : row.role === 'shelly' || row.role === 'agent'
          ? 'assistant'
          : 'system',
    parts: [{ type: 'text', text: row.content || '' }],
  }));
}

// Extract the last *user* message text from an assistant-ui UIMessage[].
// We only persist the latest user turn here — everything before it is
// already in the DB. The frontend resends the full transcript on every
// turn (assistant-ui contract), but we don't want N copies in the table.
function extractLatestUserText(uiMessages) {
  if (!Array.isArray(uiMessages) || uiMessages.length === 0) return null;
  const last = uiMessages[uiMessages.length - 1];
  if (!last || last.role !== 'user') return null;
  const parts = Array.isArray(last.parts) ? last.parts : [];
  const texts = parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text);
  return texts.join('\n').trim() || null;
}

export function mountDashboardChat(app) {
  const router = express.Router();

  // GET /api/dashboard/chat/history — returns the user's freeform thread
  // messages so the frontend can seed useChatRuntime on boot.
  router.get('/chat/history', requireForwardedUser, (req, res) => {
    try {
      const subjectId = req.user.email;
      const thread = getOrCreateThread('dashboard', subjectId);
      const rows = listMessages(thread.thread_id);
      const messages = rowsToUIMessages(rows);
      res.json({ thread_id: thread.thread_id, subject_id: subjectId, messages });
    } catch (err) {
      console.error('[dashboard-chat] history failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/dashboard/chat/turn — same body as /api/chat. Persists the
  // user message before streaming, then captures the assistant reply on
  // stream finish and writes it to the same thread.
  router.post('/chat/turn', requireForwardedUser, async (req, res) => {
    try {
      const subjectId = req.user.email;
      const thread = getOrCreateThread('dashboard', subjectId);
      const { messages, system, tools } = req.body ?? {};

      // Persist the latest user turn (idempotent — duplicates would be
      // caught by the same content+timestamp, but we don't dedupe yet).
      const userText = extractLatestUserText(messages);
      if (userText) {
        try {
          appendMessage({
            thread_id: thread.thread_id,
            role: 'user',
            source: 'web',
            content: userText,
          });
        } catch (e) {
          console.warn('[dashboard-chat] persist user msg failed:', e.message);
        }
      }

      const mcpTools = await getMCPTools();

      // Capture the assistant's text + any reasoning so we can persist a
      // clean string after the stream finishes. AI SDK 6's `onFinish`
      // gives us the full final text in `text`.
      let finalAssistantText = '';

      const result = streamText({
        model: provider.chat(MODEL),
        messages: await convertToModelMessages(messages ?? []),
        system: system ?? DEFAULT_SYSTEM,
        tools: { ...mcpTools },
        stopWhen: stepCountIs(8),
        onFinish: ({ text }) => {
          finalAssistantText = text || '';
        },
      });

      // Pipe AI SDK Data Stream Protocol response to Express. Same shape
      // as /api/chat — assistant-ui consumes it identically.
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

      // Persist assistant reply *after* the stream finishes. Done after
      // res.end() so a slow DB write can't stall the user-visible stream.
      // Best-effort — losing one row to a transient pg blip is preferable
      // to blocking the chat.
      if (finalAssistantText.trim()) {
        try {
          appendMessage({
            thread_id: thread.thread_id,
            role: 'shelly',
            source: 'web',
            content: finalAssistantText.trim(),
          });
        } catch (e) {
          console.warn('[dashboard-chat] persist assistant msg failed:', e.message);
        }
      }
    } catch (err) {
      console.error('[dashboard-chat] turn handler error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    }
  });

  app.use('/api/dashboard', router);
}
