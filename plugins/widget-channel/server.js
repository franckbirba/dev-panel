#!/usr/bin/env node
// plugins/widget-channel/server.js
//
// MCP channel that bridges the DevPanel widget to the public Shelly session.
//
// Inbound  — pops jobs from the BullMQ queue `shelly-public-inbound` and
//            pushes each one to Claude via `notifications/claude/channel`.
// Outbound — exposes the `widget_reply` tool, which POSTs the reply to the
//            DevPanel internal endpoint so it can be SSE-broadcast (or
//            buffered) for the widget tab.
//
// Designed to be started by Claude Code with stdio transport. Mirror of the
// telegram-multi plugin for the widget transport.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Worker } from 'bullmq';
import { createRequire } from 'module';
import { appendFileSync, openSync } from 'fs';

const require = createRequire(import.meta.url);
const Redis = require('ioredis');

const QUEUE_NAME = process.env.WIDGET_INBOUND_QUEUE || 'shelly-public-inbound';
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};
const CONCURRENCY = parseInt(process.env.WIDGET_CHANNEL_CONCURRENCY || '4');
const LOG_FILE = process.env.WIDGET_CHANNEL_LOG || '/home/deploy/logs/widget-channel.log';

let logFd = null;
try { logFd = openSync(LOG_FILE, 'a'); } catch {}
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stderr.write(line);
  if (logFd != null) { try { appendFileSync(logFd, line); } catch {} }
}

process.on('unhandledRejection', err => log(`widget-channel: unhandled rejection: ${err}`));
process.on('uncaughtException', err => log(`widget-channel: uncaught exception: ${err}`));

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

export const mcp = new Server(
  { name: 'widget-channel', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: [
      'Each inbound widget message arrives as <channel source="widget" session_id="..." project_id="..." project_name="..." message_id="..." ts="...">. The session_id identifies the widget tab — pass it back on every widget_reply call so the DevPanel API can deliver the reply through the right SSE stream.',
      '',
      'Use widget_reply for every answer. The widget user does not see your transcript output; they only receive what you send through widget_reply.',
      '',
      'Scope is FAQ + bug/feature triage. You have no write access to Plane, no dispatch tools, no memory_write. If a widget user asks for those, refuse politely and tell them to reach out via Telegram or the dashboard.',
    ].join('\n'),
  },
);

// Build the <channel> envelope as a content string. Claude Code itself
// builds the XML around the meta keys when the notification is delivered —
// this content is what shows up between the open/close tags.
export function buildInboundEnvelope(job) {
  const data = job.data || {};
  const { session_id, content, project_id, message_id } = data;
  return {
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        source: 'widget',
        session_id,
        // job.id is the BullMQ job id (always present); message_id from the
        // payload is the widget-side client message id (for de-dup), kept
        // alongside as widget_message_id when present.
        message_id: String(job.id ?? ''),
        ...(message_id ? { widget_message_id: String(message_id) } : {}),
        project_id: project_id ?? '',
        ts: data.enqueued_at || new Date().toISOString(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Outbound — the widget_reply tool
// ---------------------------------------------------------------------------

export async function widgetReply({ session_id, content, refs }, { fetchImpl } = {}) {
  if (!session_id || typeof session_id !== 'string') {
    throw new Error('widget_reply: session_id is required');
  }
  if (!content || typeof content !== 'string') {
    throw new Error('widget_reply: content is required');
  }
  const internalSecret = process.env.WIDGET_INTERNAL_SECRET || '';
  if (!internalSecret) {
    throw new Error('WIDGET_INTERNAL_SECRET not configured — cannot post reply');
  }
  const apiBase = (process.env.DEVPANEL_API || 'http://127.0.0.1:3030').replace(/\/$/, '');
  const fn = fetchImpl || globalThis.fetch;
  const url = `${apiBase}/api/internal/widget/sessions/${encodeURIComponent(session_id)}/reply`;
  const body = JSON.stringify({
    content,
    ...(Array.isArray(refs) ? { refs } : {}),
  });
  const resp = await fn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': internalSecret,
    },
    body,
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!resp.ok) {
    throw new Error(`widget_reply HTTP ${resp.status}: ${text}`);
  }
  return data;
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'widget_reply',
      description:
        'Reply to a widget user. Pass the session_id from the inbound <channel source="widget"> tag. Optional refs is an array of {label, url} citations (e.g. Plane page links) shown to the user beneath the reply.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'session_id attribute of the inbound channel tag' },
          content: { type: 'string', description: 'Reply text — plain text or markdown' },
          refs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                url: { type: 'string' },
              },
              required: ['label'],
            },
          },
        },
        required: ['session_id', 'content'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name !== 'widget_reply') {
    throw new Error(`unknown tool: ${name}`);
  }
  try {
    const out = await widgetReply(args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `widget_reply failed: ${err.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Inbound — BullMQ worker → notifications/claude/channel
// ---------------------------------------------------------------------------

let inboundWorker = null;

export function startInboundWorker({ connection, queueName, concurrency } = {}) {
  const conn = connection || new Redis(REDIS_CONFIG);
  const worker = new Worker(
    queueName || QUEUE_NAME,
    async (job) => {
      try {
        const envelope = buildInboundEnvelope(job);
        await mcp.notification(envelope);
        return { delivered_at: new Date().toISOString() };
      } catch (err) {
        log(`widget-channel: failed to deliver job ${job.id}: ${err.message}`);
        throw err;
      }
    },
    {
      connection: conn,
      concurrency: concurrency ?? CONCURRENCY,
    },
  );
  worker.on('failed', (job, err) => {
    log(`widget-channel: job ${job?.id} failed: ${err?.message}`);
  });
  inboundWorker = worker;
  return worker;
}

export async function stopInboundWorker() {
  if (inboundWorker) {
    await inboundWorker.close();
    inboundWorker = null;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  startInboundWorker();
  log(`widget-channel: connected, polling queue=${QUEUE_NAME} concurrency=${CONCURRENCY}`);
}

// Entry-point check — only auto-boot when invoked as a script, so tests can
// import this module without it grabbing stdio or opening Redis.
const isMain = (() => {
  try {
    const { fileURLToPath } = require('url');
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch { return false; }
})();

if (isMain) {
  main().catch(err => {
    log(`widget-channel: boot failed: ${err.message}`);
    process.exit(1);
  });
}
