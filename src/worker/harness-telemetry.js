// src/worker/harness-telemetry.js
//
// Gap #2: structured observability for harness ↔ model translation failures.
//
// Each harness (claude, pi, goose, mini-swe) translates a raw model byte
// stream into the unified `agent_job_events` shape. When the translation
// quietly recovers — Pi's JSON synthesis when Qwen3 drops the closing
// envelope, Goose's MOIM soul fallback, Claude's stream-parser malformed
// lines, etc. — the worker keeps going silently. Debugging "why did this
// job report status=done when nothing happened?" then requires reading
// `.err.log` files by hand.
//
// recordHarnessEvent() persists a typed marker on the job's event stream
// so the dashboard can surface translation gaps without touching driver
// runtime behavior. Purely additive, fire-and-forget, never throws.
//
// Event shape (stored in agent_job_events):
//   event_type    = 'system'
//   event_subtype = 'harness_telemetry'
//   payload       = { harness, kind, reason, detail, recorded_at }
//
// Seq strategy: appendEvent() does NOT auto-assign seq (see
// src/server/jobs-events.js — it expects an explicit value and relies on
// UNIQUE(job_id, seq) with ON CONFLICT DO NOTHING for retry-safety). Each
// driver maintains its own monotonic per-stream `seq` counter in closure
// scope which telemetry callers don't share. We use Date.now() as a
// sentinel — much larger than any normal stream seq (≤ a few thousand
// per run), so telemetry rows sort to the tail in listEvents(); ON
// CONFLICT swallows the rare millisecond-resolution collision.

import { appendEvent } from '../server/jobs-events.js';

/**
 * Record a harness-level translation event. Fire-and-forget; never throws.
 *
 * @param {object} args
 * @param {string|number} args.jobId   - BullMQ job id (stringified for the DB)
 * @param {string} args.harness        - 'claude' | 'pi' | 'goose' | 'mini-swe'
 * @param {string} args.kind           - taxonomy: 'parser_warning' |
 *                                       'synthesis' | 'schema_violation' |
 *                                       'fallback' | 'translation_error'
 * @param {string} args.reason         - short machine-readable code
 * @param {object} [args.detail]       - optional structured context
 */
export function recordHarnessEvent({ jobId, harness, kind, reason, detail }) {
  if (!jobId || !harness || !kind || !reason) {
    // Defensive: never throw from a telemetry call site. A misuse here
    // should be invisible to the agent run.
    console.warn('[harness-telemetry] dropped event with missing required field');
    return;
  }
  const payload = {
    harness,
    kind,
    reason,
    detail: detail || null,
    recorded_at: new Date().toISOString(),
  };
  try {
    const result = appendEvent({
      job_id: String(jobId),
      seq: Date.now(),
      event_type: 'system',
      event_subtype: 'harness_telemetry',
      payload,
    });
    // appendEvent is async; swallow rejections so a transient pg hiccup
    // can't bubble up and abort the caller's flow.
    if (result && typeof result.catch === 'function') {
      result.catch(err => {
        console.warn(`[harness-telemetry] append failed: ${err.message}`);
      });
    }
  } catch (err) {
    // Belt-and-braces — if appendEvent throws synchronously (e.g. import
    // path broken), still don't propagate.
    console.warn(`[harness-telemetry] append threw: ${err.message}`);
  }
}
