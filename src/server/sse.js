// src/server/sse.js

const clients = new Set();

export function addClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':\n\n'); // initial comment to flush headers
  clients.add(res);

  const heartbeat = setInterval(() => {
    res.write(':\n\n');
  }, 30000);

  res.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    client.write(payload);
  }
}

export function getClientCount() {
  return clients.size;
}

// ============================================================================
// Admin fan-out — separate client pool used by worker events
// ============================================================================

const adminClients = new Set();

export function addAdminClient(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':\n\n');
  adminClients.add(res);
  const hb = setInterval(() => res.write(':\n\n'), 30000);
  res.on('close', () => { clearInterval(hb); adminClients.delete(res); });
}

export function broadcastAdmin(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of adminClients) c.write(payload);
}

export function getAdminClientCount() {
  return adminClients.size;
}
