import { describe, it, expect } from 'vitest';
import {
  extractRendererPayload,
  parseRendererPayload,
  type RendererPayload,
} from '../../apps/chat/lib/chat-renderer-types';
import {
  ALL_RENDERER_EXAMPLES,
  JOB_STATUS_EXAMPLE,
  ERROR_HALT_EXAMPLE,
  INLINE_ACTIONS_EXAMPLE,
} from '../../apps/chat/lib/chat-renderer-examples';

// extractRendererPayload covers the three positions a tool result might
// carry a renderer payload in. The tests below pin each path and the
// MCP envelope shape, which is what every tool ships today.

describe('extractRendererPayload', () => {
  it('returns the payload when passed directly', () => {
    for (const example of ALL_RENDERER_EXAMPLES) {
      const result = extractRendererPayload(example);
      expect(result).not.toBeNull();
      expect(result!.type).toBe(example.type);
    }
  });

  it('returns the payload when nested under a top-level `payload` key', () => {
    const wrapped = { payload: JOB_STATUS_EXAMPLE };
    const result = extractRendererPayload(wrapped);
    expect(result?.type).toBe('job-status');
  });

  it('returns the payload from an MCP `{ content: [{ text }] }` envelope', () => {
    const envelope = {
      content: [{ type: 'text', text: JSON.stringify(ERROR_HALT_EXAMPLE) }],
    };
    const result = extractRendererPayload(envelope);
    expect(result?.type).toBe('error-halt');
  });

  it('returns the payload when MCP envelope wraps `{ payload }`', () => {
    const envelope = {
      content: [
        { type: 'text', text: JSON.stringify({ payload: INLINE_ACTIONS_EXAMPLE }) },
      ],
    };
    const result = extractRendererPayload(envelope);
    expect(result?.type).toBe('inline-actions');
  });

  it('returns null on a generic non-renderer object', () => {
    expect(extractRendererPayload({ foo: 'bar' })).toBeNull();
  });

  it('returns null on a malformed MCP envelope', () => {
    const envelope = {
      content: [{ type: 'text', text: '{not valid json' }],
    };
    expect(extractRendererPayload(envelope)).toBeNull();
  });

  it('returns null on an isError envelope (tool reported failure)', () => {
    const envelope = {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(JOB_STATUS_EXAMPLE) }],
    };
    // Tool failures should fall through to the existing error UI rather
    // than render a card from whatever the tool happened to return.
    expect(extractRendererPayload(envelope)).toBeNull();
  });

  it('round-trips against parseRendererPayload for direct payloads', () => {
    // Sanity: extractRendererPayload is a superset of parseRendererPayload
    // for the direct path. Any payload parseable should extract.
    for (const example of ALL_RENDERER_EXAMPLES) {
      const parsed = parseRendererPayload(example) as RendererPayload | null;
      const extracted = extractRendererPayload(example);
      expect(parsed?.type).toBe(extracted?.type);
    }
  });
});
