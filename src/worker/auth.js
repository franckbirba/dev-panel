// src/worker/auth.js
const ALLOWLISTS = {
  deploy: () => (process.env.DEPLOY_ALLOWED_REQUESTERS || 'franck,cron:nightly').split(',').map(s => s.trim())
};

export function assertAllowedRequester(agent, requested_by) {
  const list = ALLOWLISTS[agent];
  if (!list) return;
  const allowed = list();
  if (!allowed.includes(requested_by)) {
    throw new Error(`requested_by "${requested_by}" not allowed for agent "${agent}" (allowed: ${allowed.join(', ')})`);
  }
}
