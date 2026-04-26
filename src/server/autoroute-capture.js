// src/server/autoroute-capture.js
// Server-side autoroute: when a capture is created with a category, persist
// routing AND DM the resolved team member directly via their paired bot.
//
// Why server-side instead of letting Shelly do it:
//   notifyCaptureNew posts a [capture-new] line via the bot's sendMessage.
//   That hits Franck's DM with @Therealshelly42bot — but Shelly's
//   telegram-multi plugin only sees INBOUND messages (user -> bot), not the
//   bot's own outbound echoes via sendMessage. So Shelly never receives the
//   trigger and never acts. Doing the routing in the API container removes
//   the loop entirely.
//
// Shelly is still useful for the open-ended classification path (no category
// chosen) — see the [capture-new] reaction protocol in her SOUL. This module
// only handles the "user picked a category in the widget" happy path.

import { routeCapture } from './capture-routing.js';
import { findDevBotByLabel } from './dev-bots.js';
import { listLabelsForProject } from './team.js';
import { resolveLabel } from './team.js';

const TG_API = 'https://api.telegram.org';

async function sendDirect({ token, chat_id, text }) {
  const r = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text })
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`telegram sendMessage ${r.status}: ${body}`);
  }
}

// Match a stored category to a project routing label, case-insensitive.
// Routing was set up with `Campus` (capitalized) on Zeno but widgets may
// submit `campus`; tolerate either side.
async function findEffectiveLabel(projectId, category) {
  const labels = await listLabelsForProject(projectId);
  const lc = category.toLowerCase();
  const match = labels.find(l => l.label.toLowerCase() === lc);
  return match ? match.label : null;
}

export async function autorouteCapture({ project, capture, dashboardBase = 'https://devpanl.dev' }) {
  if (!capture || !capture.id) return { routed: false, reason: 'no capture' };
  if (!capture.routed_label) return { routed: false, reason: 'no category' };

  const effective = await findEffectiveLabel(project.id, capture.routed_label);
  if (!effective) return { routed: false, reason: `no routing for "${capture.routed_label}"` };

  const resolved = await resolveLabel(project.id, effective);
  if (!resolved) return { routed: false, reason: `label "${effective}" has no member` };

  // Persist routing on the capture (idempotent).
  const routed = await routeCapture(capture.id, effective);
  if (!routed) return { routed: false, reason: 'routeCapture returned null' };

  // Look up the bot token to DM the member.
  const bot = await findDevBotByLabel(resolved.dev_bot.label);
  if (!bot) return { routed: false, reason: `dev_bot ${resolved.dev_bot.label} not found` };

  const url = `${dashboardBase}/dashboard/captures/${capture.id}`;
  const truncated = String(capture.content || '').replace(/\s+/g, ' ').slice(0, 240);
  const text =
    `[thread:capture/${capture.id}] Salut ${resolved.member.display_name},\n\n` +
    `nouveau bug sur ${project.name} taggé "${effective}" :\n` +
    `« ${truncated} »\n\n` +
    `Tu peux répondre ici, ça atterrit dans le thread du ticket.\n` +
    `Détails: ${url}`;

  try {
    await sendDirect({
      token: bot.bot_token,
      chat_id: resolved.member.tg_user_id,
      text
    });
  } catch (err) {
    return { routed: false, reason: `telegram DM failed: ${err.message}` };
  }

  return {
    routed: true,
    member: resolved.member,
    dev_bot: { label: resolved.dev_bot.label, username: resolved.dev_bot.username },
    label: effective
  };
}
