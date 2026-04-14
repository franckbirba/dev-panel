// src/dashboard/lib/workflow-events.js
// Minimal subscriber for workflow.* SSE events on the admin stream.
//
// EventSource can't send custom headers, so the admin key is passed via the
// ?key= query parameter; `authenticateAdmin` in src/server/routes.js accepts
// that fallback for GET requests.

export function subscribeWorkflowEvents(adminKey, handlers = {}) {
  const url = `/api/admin/events`;
  const es = new EventSource(`${url}?key=${encodeURIComponent(adminKey)}`);
  for (const name of ['workflow.started', 'workflow.transitioned', 'workflow.finished']) {
    es.addEventListener(name, (e) => {
      try { handlers[name]?.(JSON.parse(e.data)); }
      catch (err) { console.warn('[workflow-events] bad payload', err); }
    });
  }
  return () => es.close();
}
