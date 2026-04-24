// Build the JSON body for POST /api/captures, attaching a `reporter`
// field only when the host app passed a plain object as `user`.
// Keeping this as a pure function (no React, no fetch) so it can be
// unit-tested without jsdom or Testing Library.
export function buildCaptureRequestPayload(user, kind, content) {
  const body = { kind, content };
  if (user && typeof user === 'object' && !Array.isArray(user)) {
    body.reporter = user;
  }
  return body;
}
