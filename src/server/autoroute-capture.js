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
import { sendDirect, sendPhoto } from './telegram-send.js';

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

// Same scan, looking for the base64 screenshot the widget attaches in the
// system message's metadata. Returns the data: URL string or null.
function extractScreenshotFromCapture(capture) {
  if (!capture || !Array.isArray(capture.messages)) return null;
  for (const m of capture.messages) {
    const meta = m && m.metadata;
    if (meta && typeof meta === 'object' && typeof meta.screenshot === 'string'
        && meta.screenshot.startsWith('data:image/')) {
      return meta.screenshot;
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

  const dashUrl = `${dashboardBase}/dashboard/captures/${capture.id}`;
  const truncated = String(full.content || '').replace(/\s+/g, ' ').slice(0, 240);
  const screenshot = extractScreenshotFromCapture(full);
  const pageUrl = extractUrlFromCapture(full);

  // Reporter — surfaces "qui a chié dans la colle" so the dev knows who to
  // ping back. Falls back to "quelqu'un" rather than a robotic "anonymous".
  const reporterName =
    (full.reporter && (full.reporter.name || full.reporter.email))
    || (full.reporter && full.reporter.id)
    || 'quelqu\'un';

  // Where it happened, in human form. URL pattern path takes priority because
  // it's already the route the user navigated to; otherwise the raw page URL.
  let where = '';
  if (pick.source === 'url-pattern' && pick.url) {
    try { where = ` sur ${new URL(pick.url).pathname}`; } catch { where = ''; }
  } else if (pageUrl) {
    try { where = ` sur ${new URL(pageUrl).pathname}`; } catch { where = ''; }
  }

  // Conversational, warm — Shelly's voice. Tag prefix preserved because the
  // capture-thread routing protocol (SOUL.md) reads it on the reply path.
  const greet = resolved.member.display_name
    ? `Salut ${resolved.member.display_name}`
    : 'Hey';
  const screenshotNote = screenshot ? '' : '\n(pas de screenshot cette fois)';
  const text =
    `[thread:capture/${capture.id}] ${greet} — ${reporterName} vient de remonter un bug sur ${project.name}${where}.\n` +
    `Ça touche "${resolved.label}" donc je te le passe.\n\n` +
    `Ce qu'il/elle dit :\n` +
    `« ${truncated} »${screenshotNote}\n\n` +
    `Tu peux répondre direct ici, ça part dans le thread du ticket.\n` +
    `Le détail complet (logs, DOM, replay) : ${dashUrl}`;

  try {
    if (screenshot) {
      await sendPhoto({
        token: bot.bot_token,
        chat_id: resolved.member.tg_user_id,
        dataUrl: screenshot,
        caption: text
      });
    } else {
      await sendDirect({
        token: bot.bot_token,
        chat_id: resolved.member.tg_user_id,
        text
      });
    }
  } catch (err) {
    // sendPhoto can fail (caption too long, image rejected) — fall back to
    // text so the dev at least gets pinged.
    if (screenshot) {
      try {
        await sendDirect({
          token: bot.bot_token,
          chat_id: resolved.member.tg_user_id,
          text
        });
      } catch (e2) {
        return { routed: false, reason: `telegram send failed: ${e2.message}` };
      }
    } else {
      return { routed: false, reason: `telegram DM failed: ${err.message}` };
    }
  }

  return {
    routed: true,
    member: resolved.member,
    dev_bot: { label: resolved.dev_bot.label, username: resolved.dev_bot.username },
    label: resolved.label,
    source: pick.source,
    with_screenshot: Boolean(screenshot)
  };
}
