#!/usr/bin/env node
// infra/shelly-relay.js — HTTP → tmux send-keys bridge on the agents host.
//
// DevPanel API pushes outbound thread messages here (as a SHELLY_TELEGRAM_WEBHOOK
// target). We inject them into Shelly's tmux session as if Franck had typed
// them, bypassing the Telegram bot echo filter that drops self-sent messages.
//
// Listens on 10.0.0.3:3031 (internal network only). Accepts POST /relay with
// JSON body {text}. Runs `tmux -L deploy send-keys -t shelly -l <text>` then
// Enter. Any caller on the agents internal net can reach it — no auth; the
// network perimeter is the security boundary.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 3031);
const HOST = process.env.HOST || '10.0.0.3';
const TMUX_SOCKET = process.env.TMUX_SOCKET || 'deploy';
const TMUX_TARGET = process.env.TMUX_TARGET || 'shelly';

function sendToTmux(text) {
  return new Promise((resolve, reject) => {
    // -l sends literal text (no keybind translation). Then Enter submits.
    const child = spawn('tmux', ['-L', TMUX_SOCKET, 'send-keys', '-t', TMUX_TARGET, '-l', text], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`send-keys literal failed (${code}): ${stderr}`));
      const enter = spawn('tmux', ['-L', TMUX_SOCKET, 'send-keys', '-t', TMUX_TARGET, 'Enter']);
      enter.on('close', (c2) => c2 === 0 ? resolve() : reject(new Error(`send-keys Enter failed (${c2})`)));
    });
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/relay') {
    res.writeHead(404); res.end('not found'); return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; if (body.length > 100_000) req.destroy(); });
  req.on('end', async () => {
    try {
      const { text } = JSON.parse(body || '{}');
      if (typeof text !== 'string' || !text.trim()) {
        res.writeHead(400); res.end(JSON.stringify({ error: 'text required' })); return;
      }
      await sendToTmux(text);
      console.log(`[shelly-relay] delivered: ${text.slice(0, 100)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('[shelly-relay] error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[shelly-relay] listening on http://${HOST}:${PORT}`);
});
