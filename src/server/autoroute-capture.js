// src/server/autoroute-capture.js
// Server-side autoroute: when a capture is created, persist routing AND DM
// the resolved team member directly via their paired bot.
//
// Why server-side: notifyCaptureNew posts via the bot's sendMessage, which
// hits Franck's DM with @Therealshelly42bot. But Shelly's telegram-multi
// plugin only sees INBOUND messages (user -> bot), not the bot's own
// outbound echoes — so Shelly never sees the trigger. Doing the routing
// here closes the loop without depending on Shelly being awake.
//
// Classification order:
//   1. capture.routed_label (widget user picked a category — rare)
//   2. URL pattern match against the capture's metadata.url
//   3. null → no autoroute, falls back to Shelly's open-ended classifier
//      via the [capture-new] reaction protocol in her SOUL.

import { routeCapture } from './capture-routing.js';
import { findDevBotByLabel } from './dev-bots.js';
import {
  resolveLabel,
  listLabelsForProject,
  classifyUrlForProject
} from './team.js';
import { getCapture } from './captures.js';

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

// Pull the page URL out of the capture's system message metadata. The widget
// posts a `Captured: screenshot · DOM snapshot` system message immediately
// after the user's content message; metadata.url carries the page.
function extractUrlFromCapture(capture) {
  if (!capture || !Array.isArray(capture.messages)) return null;
  for (const m of capture.messages) {
    const meta = m && m.metadata;
    if (meta && typeof meta === 'object' && typeof meta.url === 'string') {
      return meta.url;
    }
  }
  return null;
}

async function pickLabel({ project, capture }) {
  // 1. User picked a category in the widget — honour it (case-insensitive).
  if (capture.routed_label) {
    const labels = await listLabelsForProject(project.id);
    const lc = capture.routed_label.toLowerCase();
    const match = labels.find(l => l.label.toLowerCase() === lc);
    if (match) return { label: match.label, source: 'category' };
  }

  // 2. URL pattern classifier.
  const url = extractUrlFromCapture(capture);
  if (url) {
    const matched = await classifyUrlForProject(project.id, url);
    if (matched) return { label: matched, source: 'url-pattern', url };
  }

  return null;
}

export async function autorouteCapture({ project, capture, dashboardBase = 'https://devpanl.dev' }) {
  if (!capture || !capture.id) return { routed: false, reason: 'no capture' };

  // Fetch the full capture with messages so we can inspect metadata.url.
  // The caller may have passed a partial capture object; re-fetching ensures
  // we always see the system message that carries the URL.
  const full = getCapture(capture.id) || capture;

  const pick = await pickLabel({ project, capture: full });
  if (!pick) return { routed: false, reason: 'no label match' };

  const resolved = await resolveLabel(project.id, pick.label);
  if (!resolved) return { routed: false, reason: `label "${pick.label}" has no member` };

  const routed = await routeCapture(capture.id, resolved.label || pick.label);
  if (!routed) return { routed: false, reason: 'routeCapture returned null' };

  const bot = await findDevBotByLabel(resolved.dev_bot.label);
  if (!bot) return { routed: false, reason: `dev_bot ${resolved.dev_bot.label} not found` };

  const url = `${dashboardBase}/dashboard/captures/${capture.id}`;
  const truncated = String(full.content || '').replace(/\s+/g, ' ').slice(0, 240);
  const sourceNote = pick.source === 'url-pattern' && pick.url
    ? ` (depuis ${new URL(pick.url).pathname})`
    : '';
  const text =
    `[thread:capture/${capture.id}] Salut ${resolved.member.display_name},\n\n` +
    `nouveau bug sur ${project.name} taggé "${resolved.label}"${sourceNote} :\n` +
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
    label: resolved.label,
    source: pick.source
  };
}
