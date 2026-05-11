// @devpanl/chat-renderer — runtime parser, shared between every chat surface.
//
// The canonical type schema lives in TypeScript at
// `apps/chat/lib/chat-renderer-types.ts` (TS discriminated union, per the
// project convention documented in CLAUDE.md — *not* Zod). That file imports
// `parseRendererPayload` from here and re-exports it so the dashboard chat
// keeps its existing import path, while the widget (plain JS) can pull the
// parser directly without dragging TS through its bundle.
//
// Why two files: the widget ships via Vite as plain JS into `dist/widget.js`
// and is consumed by host apps that have zero TS toolchain. Putting the
// parser in `.js` lets both surfaces share one implementation.

export const RENDERER_PAYLOAD_TYPES = Object.freeze([
  'job-status',
  'console-stream',
  'terminal-session',
  'error-halt',
  'inline-actions',
  'react-canvas',
  'queue-card',
  'subject-constellation',
]);

function isObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function hasStringField(o, k) {
  return typeof o[k] === 'string';
}

function hasArrayField(o, k) {
  return Array.isArray(o[k]);
}

/**
 * Narrow an unknown payload to a RendererPayload. Returns null on shape
 * mismatch — callers fall back to ToolFallback / raw rendering. We validate
 * only the discriminator + the small set of fields each card actually needs
 * to render; everything else is treated as opt-in.
 *
 * @param {unknown} input
 * @returns {object|null}
 */
export function parseRendererPayload(input) {
  if (!isObject(input)) return null;
  const t = input.type;
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'job-status':
      if (!hasStringField(input, 'job_id')) return null;
      if (!hasStringField(input, 'name')) return null;
      if (!hasStringField(input, 'state')) return null;
      return input;
    case 'console-stream':
      if (!hasStringField(input, 'title')) return null;
      if (!hasArrayField(input, 'lines')) return null;
      return input;
    case 'terminal-session':
      if (!hasStringField(input, 'session_id')) return null;
      if (!hasStringField(input, 'host')) return null;
      return input;
    case 'error-halt':
      if (!hasStringField(input, 'error_code')) return null;
      if (!hasStringField(input, 'message')) return null;
      return input;
    case 'inline-actions':
      if (!hasArrayField(input, 'actions')) return null;
      return input;
    case 'react-canvas':
      if (!hasStringField(input, 'tsx')) return null;
      return input;
    case 'queue-card':
      if (!hasStringField(input, 'title')) return null;
      if (!hasArrayField(input, 'items')) return null;
      return input;
    case 'subject-constellation':
      if (!isObject(input.center)) return null;
      if (!isObject(input.groups)) return null;
      return input;
    default:
      return null;
  }
}

/**
 * Extract a RendererPayload from an arbitrary tool result. Three positions
 * tried in order: (a) the result itself, (b) a top-level `payload` key,
 * (c) MCP wire envelope `{ content: [{ type: 'text', text: '<json>' }] }`
 * with the payload inside the parsed JSON (or under `payload` within it).
 *
 * @param {unknown} result
 * @returns {object|null}
 */
export function extractRendererPayload(result) {
  const direct = parseRendererPayload(result);
  if (direct) return direct;
  if (!isObject(result)) return null;

  if ('payload' in result) {
    const nested = parseRendererPayload(result.payload);
    if (nested) return nested;
  }

  // MCP wire shape — the only tool transport in use today.
  if (Array.isArray(result.content) && !result.isError) {
    const first = result.content[0];
    if (first && typeof first.text === 'string') {
      try {
        const parsed = JSON.parse(first.text);
        const fromText = parseRendererPayload(parsed);
        if (fromText) return fromText;
        if (isObject(parsed) && 'payload' in parsed) {
          const fromTextNested = parseRendererPayload(parsed.payload);
          if (fromTextNested) return fromTextNested;
        }
      } catch {
        return null;
      }
    }
  }

  return null;
}
