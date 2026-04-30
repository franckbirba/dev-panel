// Persisted widget session id. One per browser/origin — used to key
// localStorage state and as the `:id` segment in /api/widget/sessions/:id/*.

export const SESSION_STORAGE_KEY = 'devpanel.widget.session_id';

function generate() {
  return 'ws_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4);
}

export function getOrCreateSessionId() {
  if (typeof localStorage === 'undefined') return generate();
  let id = null;
  try { id = localStorage.getItem(SESSION_STORAGE_KEY); } catch { /* private mode */ }
  if (!id) {
    id = generate();
    try { localStorage.setItem(SESSION_STORAGE_KEY, id); } catch { /* private mode */ }
  }
  return id;
}
