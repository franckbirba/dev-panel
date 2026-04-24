// Build the JSON body for POST /api/captures.
// - `user` (object) → `reporter` field on the body.
// - `environment` (non-empty string) → `environment` field on the body.
// Both are optional. Pure function — no React, no fetch — so tests can run
// without jsdom.
export function buildCaptureRequestPayload(user, kind, content, environment) {
  const body = { kind, content };
  if (user && typeof user === 'object' && !Array.isArray(user)) {
    body.reporter = user;
  }
  if (typeof environment === 'string' && environment.length > 0) {
    body.environment = environment;
  }
  return body;
}
