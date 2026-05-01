// src/server/webhooks-glitchtip.js
// GlitchTip (Sentry-API-compatible) webhook handler.
//
// Each incoming event lands in the captures inbox just like a widget bug
// report so that auto-detected runtime errors flow through the same Shelly
// triage → Plane promotion pipeline. Spec: DEVPA-169 / Plane page
// "Observability — error tracking (GlitchTip)" §7.
//
// Auth: HMAC-SHA256(rawBody, GLITCHTIP_BRIDGE_HMAC_SECRET) compared against
// the `x-glitchtip-signature` header. Matches the GitHub webhook pattern in
// webhooks-github.js — raw body captured via express.raw() before
// express.json() runs in createServer().

import crypto from 'crypto';
import express from 'express';
import { getProjectById } from './db.js';
import { upsertGlitchTipCapture, resolveGlitchTipCapture } from './captures.js';

const WEBHOOK_SECRET = process.env.GLITCHTIP_BRIDGE_HMAC_SECRET;

// Per-project sliding-window rate limit. Keeps a runaway error loop in a
// client app from flooding the captures inbox. 100 events/min/project is
// generous (a real bug spike rarely exceeds this; if it does, the dedup
// logic still merges fingerprints — the limit only protects against
// thousands of *distinct* fingerprints exploding at once).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;
const rateBuckets = new Map(); // project_id -> array<timestamp>

export function __resetRateLimitsForTests() {
  rateBuckets.clear();
}

function checkRateLimit(projectId, now = Date.now()) {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = (rateBuckets.get(projectId) || []).filter(t => t > cutoff);
  if (bucket.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(projectId, bucket);
    return false;
  }
  bucket.push(now);
  rateBuckets.set(projectId, bucket);
  return true;
}

export function verifySignature(payload, signature, secret = WEBHOOK_SECRET) {
  if (!secret || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  // GlitchTip's webhook signature is the raw hex digest (no `sha256=` prefix
  // unlike GitHub). Some signers do prepend `sha256=` though, so we strip it
  // defensively to keep the verifier robust against either convention.
  const provided = String(signature).replace(/^sha256=/, '');
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Constant-time shared-secret comparison for the URL-querystring auth path.
// GlitchTip's "Generic Webhook" alert recipient does NOT sign payloads
// (we discovered this during DEVPA-168 bring-up — the original spec was
// wrong). The capability-URL pattern is the simplest fix: the secret
// rides in `?secret=<hex>` and we timing-safe-compare it against the
// configured WEBHOOK_SECRET. The bridge URL itself is the bearer token.
export function verifyQuerystringSecret(provided, secret = WEBHOOK_SECRET) {
  if (!secret || !provided) return false;
  try {
    const a = Buffer.from(String(secret));
    const b = Buffer.from(String(provided));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Build the capture content body from a GlitchTip issue payload. The shape
// matches Sentry's standard webhook envelope; GlitchTip mirrors it. We
// truncate stack trace + breadcrumbs to keep the row small (the full data
// is one click away via external_url).
const STACK_TRACE_MAX = 4096;
const BREADCRUMBS_MAX = 2048;

export function buildContent(issue = {}) {
  const lines = [];
  if (issue.title) lines.push(issue.title);
  if (issue.culprit) lines.push(`at ${issue.culprit}`);
  if (issue.metadata?.value && issue.metadata.value !== issue.title) {
    lines.push(issue.metadata.value);
  }
  const trace = formatStackTrace(issue);
  if (trace) {
    lines.push('', '--- stack trace ---', truncate(trace, STACK_TRACE_MAX));
  }
  const crumbs = formatBreadcrumbs(issue);
  if (crumbs) {
    lines.push('', '--- breadcrumbs ---', truncate(crumbs, BREADCRUMBS_MAX));
  }
  return lines.join('\n');
}

function formatStackTrace(issue) {
  const exc = issue.metadata?.exception?.values?.[0]
           ?? issue.exception?.values?.[0];
  const frames = exc?.stacktrace?.frames;
  if (!Array.isArray(frames) || frames.length === 0) return null;
  // Sentry/GlitchTip frames are oldest-to-newest; reverse to a more familiar
  // top-of-stack-first view.
  return frames.slice().reverse().map(f => {
    const where = [f.filename || f.module, f.lineno, f.colno].filter(Boolean).join(':');
    const fn = f.function || '<anonymous>';
    return `  at ${fn} (${where})${f.context_line ? `\n    ${f.context_line.trim()}` : ''}`;
  }).join('\n');
}

function formatBreadcrumbs(issue) {
  const items = issue.breadcrumbs?.values || issue.metadata?.breadcrumbs?.values;
  if (!Array.isArray(items) || items.length === 0) return null;
  return items.slice(-20).map(b => {
    const ts = b.timestamp ? new Date(b.timestamp * 1000).toISOString() : '';
    const cat = b.category || b.type || 'log';
    const msg = b.message || (b.data ? JSON.stringify(b.data) : '');
    return `[${ts}] (${cat}) ${msg}`.trim();
  }).join('\n');
}

function truncate(s, max) {
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// Pull fingerprint out of the GlitchTip payload. GlitchTip sets
// issue.fingerprint as an array of strings (joined with hyphens upstream),
// but for Sentry-classic events it can also live at issue.id. We hash the
// joined fingerprint to keep the column bounded; the raw value is preserved
// in external_url via the issue permalink.
export function deriveFingerprint(issue = {}) {
  let raw = null;
  if (Array.isArray(issue.fingerprint) && issue.fingerprint.length > 0) {
    raw = issue.fingerprint.join('|');
  } else if (typeof issue.fingerprint === 'string' && issue.fingerprint.length > 0) {
    raw = issue.fingerprint;
  } else if (issue.id != null) {
    raw = `issue:${issue.id}`;
  }
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

const HANDLED_ACTIONS = new Set(['created', 'regression', 'resolved']);

export function mountGlitchTipWebhook(app) {
  app.post('/api/webhooks/glitchtip/:devpanlProjectId',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      try {
        const rawBody = req.body;
        const projectId = req.params.devpanlProjectId;

        // Verify project exists. We do this BEFORE HMAC verify so that an
        // attacker scanning random project ids can't use timing to learn
        // valid ones; both paths return early with 4xx.
        const project = getProjectById(projectId);
        if (!project) {
          return res.status(404).json({ error: 'unknown project' });
        }

        // Auth — accept either of two paths, in this order:
        //   1. HMAC header (x-glitchtip-signature / x-sentry-hook-signature
        //      / x-hub-signature-256). Kept for any future signed source
        //      and for the original Sentry-style enterprise webhooks.
        //   2. Shared secret in `?secret=<hex>`. This is what GlitchTip's
        //      "Generic Webhook" alert recipient uses today — it does NOT
        //      sign bodies, so the URL itself carries the auth.
        // If GLITCHTIP_BRIDGE_HMAC_SECRET is unset and we're in production,
        // the route refuses everything. Outside production (tests, local
        // dev) it accepts unauthenticated requests for convenience.
        if (WEBHOOK_SECRET) {
          const sig = req.headers['x-glitchtip-signature']
                   || req.headers['x-sentry-hook-signature']
                   || req.headers['x-hub-signature-256'];
          const querySecret = req.query?.secret;
          const ok = (sig && verifySignature(rawBody, sig))
                  || (querySecret && verifyQuerystringSecret(querySecret));
          if (!ok) {
            return res.status(401).json({ error: 'invalid signature' });
          }
        } else if (process.env.NODE_ENV === 'production') {
          return res.status(503).json({ error: 'webhook not configured' });
        }

        // Per-project rate limit. We apply it AFTER auth so unauthenticated
        // floods don't bump legitimate projects' counters.
        if (!checkRateLimit(projectId)) {
          return res.status(429).json({ error: 'rate limit exceeded' });
        }

        // Parse body (raw Buffer → JSON)
        let payload;
        try {
          payload = JSON.parse(
            Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody
          );
        } catch {
          return res.status(400).json({ error: 'invalid JSON' });
        }

        const action = payload.action;
        const issue = payload.data?.issue;
        if (!action || !issue) {
          return res.status(400).json({ error: 'missing action or issue' });
        }
        if (!HANDLED_ACTIONS.has(action)) {
          return res.status(204).end();
        }

        const fingerprint = deriveFingerprint(issue);
        if (!fingerprint) {
          return res.status(400).json({ error: 'missing issue fingerprint' });
        }

        if (action === 'resolved') {
          const capture = resolveGlitchTipCapture({
            project_id: projectId,
            fingerprint
          });
          return res.status(200).json({
            ok: true,
            action,
            resolved: capture ? capture.id : null
          });
        }

        // created or regression → upsert
        const content = buildContent(issue) || issue.title || '(unknown error)';
        const result = upsertGlitchTipCapture({
          project_id: projectId,
          fingerprint,
          content,
          external_url: issue.permalink || null,
          environment: issue.metadata?.environment || null
        });

        return res.status(result.deduped ? 200 : 201).json({
          ok: true,
          action,
          capture_id: result.capture.id,
          deduped: result.deduped,
          occurrence_count: result.capture.occurrence_count
        });

      } catch (err) {
        console.error('[webhook:glitchtip] error:', err);
        return res.status(500).json({ error: 'internal error' });
      }
    }
  );
}
