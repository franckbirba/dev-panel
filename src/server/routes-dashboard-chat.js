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
import { experimental_createMCPClient as createMCPClient } from '@ai-sdk/mcp';
import { streamText, stepCountIs, convertToModelMessages } from 'ai';
import { resolveChatModel } from './chat-providers.js';
import { makeTextScrubber } from './chat-text-scrubber.js';
import { gateToolWithPermission } from './chat-permissions.js';
import {
  getOrCreateThread,
  listMessages,
  appendMessage,
  copyMessagesIntoThread,
} from './threads.js';
import { upsertSubject } from './subjects.js';
import { getProjectByName, getMasterDatabase } from './db.js';
import { requireForwardedUser } from './middleware/require-forwarded-user.js';
import { extractRendererPayload } from '../packages/chat-renderer/parser.js';
import { connectExternalMCPs } from './external-mcp.js';

// Dashboard subjects are synthetic — one per SSO user. The schema's
// project_id NOT NULL FK forces a real project, so we anchor every
// dashboard subject on the `dev-panel` project itself (the chat is
// part of devpanel-the-product). ensureDashboardSubject is idempotent.
let cachedDevPanelProjectId = null;
function getDevPanelProjectId() {
  if (cachedDevPanelProjectId) return cachedDevPanelProjectId;
  const proj = getProjectByName('dev-panel');
  if (!proj) {
    throw new Error('dev-panel project not found in projects table');
  }
  cachedDevPanelProjectId = proj.id;
  return cachedDevPanelProjectId;
}

function ensureDashboardSubject(email) {
  upsertSubject({
    subject_type: 'dashboard',
    subject_id: email,
    project_id: getDevPanelProjectId(),
    title: email,
  });
}

// Multi-thread support — DEVPA-204 phase 2.
//
// Subject id convention: `<email>` for the freeform thread (legacy, the
// only one before this PR), `<email>:<n>` for additional threads created
// via the "New Thread" sidebar button. n starts at 2; n=1 maps to the
// freeform thread for compatibility.
//
// Why subject_id encoding instead of a separate `chat_threads` table:
// the existing threads table is already keyed by (subject_type,
// subject_id) and powers Telegram + the dashboard side-by-side. Adding
// another table forks the truth-source. Sticking to subject_id keeps
// one place threads live.

function ensureDashboardThreadSubject(email, n) {
  const subjectId = n === 1 ? email : `${email}:${n}`;
  upsertSubject({
    subject_type: 'dashboard',
    subject_id: subjectId,
    project_id: getDevPanelProjectId(),
    title: n === 1 ? email : `${email} (thread ${n})`,
  });
  return subjectId;
}

function listDashboardThreadsForUser(email) {
  // Pull every threads row whose subject_id is the user's email or starts
  // with `<email>:`. Cheap because subject_type filters first.
  const db = getMasterDatabase();
  const rows = db.prepare(
    `SELECT t.thread_id, t.subject_id, t.last_message_at, t.created_at,
            (SELECT content FROM thread_messages
              WHERE thread_id = t.thread_id AND role='user'
              ORDER BY id ASC LIMIT 1) AS first_user_text
       FROM threads t
      WHERE t.subject_type = 'dashboard'
        AND (t.subject_id = ? OR t.subject_id LIKE ?)
      ORDER BY COALESCE(t.last_message_at, t.created_at) DESC`
  ).all(email, `${email}:%`);
  return rows.map((r) => ({
    thread_id: r.thread_id,
    subject_id: r.subject_id,
    n: r.subject_id === email ? 1 : Number(r.subject_id.split(':').pop()),
    last_message_at: r.last_message_at,
    created_at: r.created_at,
    title: r.first_user_text
      ? r.first_user_text.slice(0, 60).replace(/\s+/g, ' ').trim()
      : '(empty)',
  }));
}

function nextThreadN(email) {
  const existing = listDashboardThreadsForUser(email);
  if (existing.length === 0) return 1;
  const maxN = Math.max(...existing.map((t) => t.n));
  return maxN + 1;
}

function resolveSubjectFromN(email, n) {
  return n === 1 ? email : `${email}:${n}`;
}

// Per-request provider resolution lives in `./chat-providers.js`
// (shared with /api/chat). Reads `x-devpanl-provider` per turn,
// validates against an allowlist, falls back to env defaults.
// (DEVPA-213)

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

// Wrap an MCP tool's execute so any result that claims to be a renderer
// payload is run through `extractRendererPayload` before the AI SDK streams
// it. On shape drift the result is replaced with a one-shot `error-halt`
// renderer payload so the dashboard surfaces something actionable instead
// of letting the chat render raw JSON. The schema in
// `apps/chat/lib/chat-renderer-types.ts` is the single source of truth for
// what "claims to be a renderer payload" means — server + chat share the
// same parser (`src/packages/chat-renderer/parser.js`).
function wrapToolWithRendererValidation(toolName, tool) {
  if (!tool || typeof tool.execute !== 'function') return tool;
  const originalExecute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: async (args, ctx) => {
      const result = await originalExecute(args, ctx);
      const payload = extractRendererPayload(result);
      if (!payload && looksLikeRendererAttempt(result)) {
        // The handler tried to emit a renderer payload but the shape is
        // off — swap in a structured error-halt so the chat still has
        // *something* to render and the agent gets a clear signal in the
        // tool-result it can correct on the next step.
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                type: 'error-halt',
                error_code: 'RENDERER_PAYLOAD_INVALID',
                message: `Tool ${toolName} returned a renderer payload with an invalid shape.`,
                source: toolName,
              }),
            },
          ],
        };
      }
      return result;
    },
  };
}

// Detect "the handler meant to return a renderer payload but the shape is
// off". Two signals: (a) the result itself or a nested `payload` carries a
// `type` field that matches one of the known renderer kinds, (b) the MCP
// envelope contains parseable text whose `.type` matches. Anything else
// is left alone — capability handlers free-form JSON is fine, only invalid
// renderer-payload attempts get rewritten.
const KNOWN_RENDERER_KINDS = new Set([
  'job-status',
  'console-stream',
  'terminal-session',
  'error-halt',
  'inline-actions',
  'react-canvas',
  'queue-card',
]);

function looksLikeRendererAttempt(result) {
  if (!result || typeof result !== 'object') return false;
  if (KNOWN_RENDERER_KINDS.has(result.type)) return true;
  if (result.payload && KNOWN_RENDERER_KINDS.has(result.payload?.type)) return true;
  if (Array.isArray(result.content) && result.content[0]?.type === 'text') {
    try {
      const parsed = JSON.parse(result.content[0].text);
      if (KNOWN_RENDERER_KINDS.has(parsed?.type)) return true;
      if (KNOWN_RENDERER_KINDS.has(parsed?.payload?.type)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function getMCPTools() {
  if (cachedMCPTools) return cachedMCPTools;
  const url = process.env.DEVPANEL_MCP_URL ?? 'https://devpanl.dev/mcp';
  const token = process.env.ADMIN_API_KEY;

  // Connect the devpanel-prod HTTP MCP + AFFiNE/GitHub stdio MCPs in
  // parallel. We collect partial results — if one connector dies the
  // others still surface. This is the same isolation behaviour the
  // original HTTP-only path had (try/catch returns {}), generalised
  // across N transports.
  /** @type {Record<string, unknown>} */
  let devpanelTools = {};
  /** @type {Record<string, unknown>} */
  let externalTools = {};

  const tasks = [];
  if (token) {
    tasks.push(
      (async () => {
        try {
          mcpClient = await createMCPClient({
            transport: {
              type: 'http',
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          });
          devpanelTools = await mcpClient.tools();
        } catch (e) {
          console.warn(
            '[dashboard-chat] devpanel-prod MCP connect failed:',
            e.message,
          );
        }
      })(),
    );
  } else {
    console.warn(
      '[dashboard-chat] ADMIN_API_KEY missing — devpanel-prod MCP disabled',
    );
  }
  tasks.push(
    (async () => {
      externalTools = await connectExternalMCPs();
    })(),
  );
  await Promise.all(tasks);

  const merged = { ...devpanelTools, ...externalTools };
  // Apply permission gate first (so the gate runs *before* renderer
  // validation — the gate's inline-actions payload is itself a valid
  // renderer shape, so it passes through validation unchanged), then
  // wrap with renderer-payload validation as before.
  cachedMCPTools = Object.fromEntries(
    Object.entries(merged).map(([name, tool]) => [
      name,
      wrapToolWithRendererValidation(name, gateToolWithPermission(name, tool)),
    ]),
  );
  console.log(
    `[dashboard-chat] MCP tools mounted: ${Object.keys(cachedMCPTools).length} total ` +
      `(devpanel: ${Object.keys(devpanelTools).length}, external: ${Object.keys(externalTools).length})`,
  );
  return cachedMCPTools;
}

// Map our DB-row shape to assistant-ui's UIMessage shape.
//
// Two storage formats coexist:
//   - Legacy rows: `metadata` is null, `content` is plain text → wrap as
//     a single text part. This is how user messages are stored, and how
//     pre-DEVPA-204-part-2 assistant replies were stored.
//   - Rich rows: `metadata.parts` is the full UIMessagePart[] (text +
//     tool-call + tool-result, etc). On reload, the registry's
//     `makeAssistantToolUI` hooks see the tool-call parts and re-render
//     the cards inline. This is what unlocks "reload still shows cards".
//
// role normalization:
//   - 'user'   → 'user'
//   - 'shelly' → 'assistant'  (the chat presents Shelly as the assistant)
//   - other    → 'system'
function rowsToUIMessages(rows) {
  return rows.map((row) => {
    const role =
      row.role === 'user'
        ? 'user'
        : row.role === 'shelly' || row.role === 'agent'
          ? 'assistant'
          : 'system';
    // Try the rich path first.
    if (row.metadata && Array.isArray(row.metadata.parts)) {
      return {
        id: String(row.id),
        role,
        parts: row.metadata.parts,
      };
    }
    // Fallback — legacy row, single text part.
    return {
      id: String(row.id),
      role,
      parts: [{ type: 'text', text: row.content || '' }],
    };
  });
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

  // GET /api/dashboard/chat/threads — list this user's dashboard threads.
  router.get('/chat/threads', requireForwardedUser, (req, res) => {
    try {
      // Ensure the freeform thread exists so a brand-new user always has
      // at least one row to switch into.
      ensureDashboardThreadSubject(req.user.email, 1);
      getOrCreateThread('dashboard', req.user.email);
      const threads = listDashboardThreadsForUser(req.user.email);
      res.json({ threads });
    } catch (err) {
      console.error('[dashboard-chat] list threads failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/dashboard/chat/threads — create a new dashboard thread.
  // Returns the new thread's `n` (sidebar uses this as the routing key).
  router.post('/chat/threads', requireForwardedUser, (req, res) => {
    try {
      const email = req.user.email;
      const n = nextThreadN(email);
      const subjectId = ensureDashboardThreadSubject(email, n);
      const thread = getOrCreateThread('dashboard', subjectId);
      res.json({
        thread_id: thread.thread_id,
        subject_id: subjectId,
        n,
        title: '(empty)',
        last_message_at: null,
        created_at: thread.created_at,
      });
    } catch (err) {
      console.error('[dashboard-chat] create thread failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/dashboard/chat/threads/:source_n/fork — create a new
  // dashboard thread seeded with messages from an existing thread.
  // Body: { from_message_id?: number } — copies messages whose id is
  // <= from_message_id; if omitted, copies the whole source thread.
  // Returns the same shape as the create-thread endpoint above so the
  // frontend can switch into the new thread the same way.
  router.post('/chat/threads/:source_n/fork', requireForwardedUser, (req, res) => {
    try {
      const email = req.user.email;
      const sourceN = Math.max(1, parseInt(req.params.source_n, 10) || 1);
      const sourceSubject = ensureDashboardThreadSubject(email, sourceN);
      const source = getOrCreateThread('dashboard', sourceSubject);

      const upToMessageIdRaw = req.body?.from_message_id;
      const upToMessageId = upToMessageIdRaw == null
        ? null
        : Math.max(0, parseInt(upToMessageIdRaw, 10) || 0);

      // Allocate the next n the same way the create-thread endpoint
      // does — fork is just "a new thread seeded with a prefix".
      const newN = nextThreadN(email);
      const newSubject = ensureDashboardThreadSubject(email, newN);
      const target = getOrCreateThread('dashboard', newSubject);

      const copied = copyMessagesIntoThread({
        source_thread_id: source.thread_id,
        target_thread_id: target.thread_id,
        upToMessageId,
      });

      res.json({
        thread_id: target.thread_id,
        subject_id: newSubject,
        n: newN,
        forked_from: { thread_id: source.thread_id, n: sourceN, from_message_id: upToMessageId },
        copied_messages: copied,
        created_at: target.created_at,
      });
    } catch (err) {
      console.error('[dashboard-chat] fork thread failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/dashboard/chat/history?n=<index> — messages for a specific
  // thread. Defaults to n=1 (the freeform thread) for backward-compat.
  router.get('/chat/history', requireForwardedUser, (req, res) => {
    try {
      const email = req.user.email;
      const n = Math.max(1, parseInt(req.query.n, 10) || 1);
      const subjectId = ensureDashboardThreadSubject(email, n);
      const thread = getOrCreateThread('dashboard', subjectId);
      const rows = listMessages(thread.thread_id);
      const messages = rowsToUIMessages(rows);
      res.json({ thread_id: thread.thread_id, subject_id: subjectId, n, messages });
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
      const email = req.user.email;
      const n = Math.max(1, parseInt(req.query.n, 10) || 1);
      const subjectId = ensureDashboardThreadSubject(email, n);
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
      const { model } = resolveChatModel(req.get('x-devpanl-provider'));

      const result = streamText({
        model,
        messages: await convertToModelMessages(messages ?? []),
        system: system ?? DEFAULT_SYSTEM,
        tools: { ...mcpTools },
        stopWhen: stepCountIs(8),
        experimental_transform: makeTextScrubber,
      });

      // Persist the assistant reply *inside* onFinish, before res.end().
      // onFinish fires when the model has produced its final UIMessage —
      // synchronous to the stream's drain on the server side, so the
      // appendMessage commits before the reader-loop below ever sees
      // `done: true`. If the Node process restarts after res.end(), the
      // reply is already durably stored. (DEVPA-215)
      //
      // Stored shape:
      //   - content: text-only join, for legacy readers (Telegram bridge,
      //     `transcript_replay_recent` MCP tool, etc).
      //   - metadata.parts: the full UIMessagePart[] so reloads can
      //     re-render tool-call cards via the makeAssistantToolUI registry.
      const response = result.toUIMessageStreamResponse({
        sendReasoning: true,
        onFinish: ({ messages: outMessages }) => {
          const last = Array.isArray(outMessages)
            ? outMessages[outMessages.length - 1]
            : null;
          if (!last || !Array.isArray(last.parts)) return;
          const textOnly = last.parts
            .filter((p) => p?.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text)
            .join('\n')
            .trim();
          try {
            appendMessage({
              thread_id: thread.thread_id,
              role: 'shelly',
              source: 'web',
              content: textOnly || '(tool calls only — see metadata.parts)',
              metadata: { parts: last.parts },
            });
          } catch (e) {
            // Best-effort — a transient DB blip must not break the stream.
            console.warn('[dashboard-chat] persist assistant msg failed:', e.message);
          }
        },
      });

      // Pipe AI SDK Data Stream Protocol response to Express. Same shape
      // as /api/chat — assistant-ui consumes it identically.
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
      console.error('[dashboard-chat] turn handler error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.end();
    }
  });

  app.use('/api/dashboard', router);
}
