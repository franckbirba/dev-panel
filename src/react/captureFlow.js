// Shared capture submission flow used by both the bug form (DevPanel) and the
// chat drawer's "Reporter un bug" mode. Hits POST /api/captures, then attaches
// browser context as a system thread message.

import { buildCaptureRequestPayload } from './reporterPayload.js';

function describeMetadata(metadata) {
  return [
    metadata.screenshot ? 'screenshot' : null,
    metadata.dom ? 'DOM snapshot' : null,
    metadata.appState ? 'app state' : null,
    Array.isArray(metadata.console) && metadata.console.length > 0
      ? `${metadata.console.length} console entries` : null,
    Array.isArray(metadata.network) && metadata.network.length > 0
      ? `${metadata.network.length} network events` : null,
  ].filter(Boolean).join(' · ') || 'browser context';
}

export async function postCapture({
  apiUrl, apiKey, user, environment, kind, content, metadata, category,
}) {
  const payload = buildCaptureRequestPayload(user, kind, content, environment);
  if (category) payload.category = category;

  const createRes = await fetch(`${apiUrl}/api/captures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
    body: JSON.stringify(payload),
  });
  if (!createRes.ok) {
    const errData = await createRes.json().catch(() => ({}));
    throw new Error(errData.error || `HTTP ${createRes.status}`);
  }
  const capture = await createRes.json();

  if (metadata) {
    await fetch(`${apiUrl}/api/threads/capture/${capture.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({
        role: 'system',
        content: `Captured: ${describeMetadata(metadata)}`,
        metadata,
      }),
    }).catch(() => { /* context attachment is best-effort */ });
  }

  return capture;
}
