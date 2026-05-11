import { describe, it, expect } from 'vitest';
import {
  parseRendererPayload,
  RENDERER_PAYLOAD_TYPES,
  type RendererPayload,
} from '../../apps/chat/lib/chat-renderer-types';
import {
  ALL_RENDERER_EXAMPLES,
  JOB_STATUS_EXAMPLE,
  CONSOLE_STREAM_EXAMPLE,
  TERMINAL_SESSION_EXAMPLE,
  ERROR_HALT_EXAMPLE,
  INLINE_ACTIONS_EXAMPLE,
  REACT_CANVAS_EXAMPLE,
  QUEUE_CARD_EXAMPLE,
} from '../../apps/chat/lib/chat-renderer-examples';

describe('parseRendererPayload', () => {
  it('accepts every example payload', () => {
    for (const example of ALL_RENDERER_EXAMPLES) {
      const result = parseRendererPayload(example);
      expect(result, `example of type ${example.type} failed`).not.toBeNull();
      expect(result!.type).toBe(example.type);
    }
  });

  it('rejects non-objects', () => {
    expect(parseRendererPayload(null)).toBeNull();
    expect(parseRendererPayload(undefined)).toBeNull();
    expect(parseRendererPayload('job-status')).toBeNull();
    expect(parseRendererPayload(42)).toBeNull();
    expect(parseRendererPayload([])).toBeNull();
  });

  it('rejects unknown discriminators', () => {
    expect(
      parseRendererPayload({ type: 'unknown-card', name: 'x', job_id: 'y', state: 'queued' }),
    ).toBeNull();
  });

  it('rejects job-status missing required fields', () => {
    expect(parseRendererPayload({ type: 'job-status' })).toBeNull();
    expect(parseRendererPayload({ type: 'job-status', name: 'x' })).toBeNull();
    expect(
      parseRendererPayload({ type: 'job-status', job_id: 'j', name: 'n' }),
    ).toBeNull();
  });

  it('rejects console-stream without a lines array', () => {
    expect(
      parseRendererPayload({ type: 'console-stream', title: 't' }),
    ).toBeNull();
    expect(
      parseRendererPayload({ type: 'console-stream', title: 't', lines: 'oops' }),
    ).toBeNull();
  });

  it('rejects error-halt without code or message', () => {
    expect(parseRendererPayload({ type: 'error-halt' })).toBeNull();
    expect(
      parseRendererPayload({ type: 'error-halt', error_code: 'X' }),
    ).toBeNull();
  });

  it('rejects react-canvas without tsx source', () => {
    expect(parseRendererPayload({ type: 'react-canvas' })).toBeNull();
  });

  it('rejects queue-card without items array', () => {
    expect(
      parseRendererPayload({ type: 'queue-card', title: 't' }),
    ).toBeNull();
  });
});

describe('RENDERER_PAYLOAD_TYPES', () => {
  it('lists exactly the seven DEVPA-218 component types', () => {
    expect(RENDERER_PAYLOAD_TYPES).toEqual([
      'job-status',
      'console-stream',
      'terminal-session',
      'error-halt',
      'inline-actions',
      'react-canvas',
      'queue-card',
    ]);
  });

  it('has one example per type', () => {
    const exampleTypes = ALL_RENDERER_EXAMPLES.map((e) => e.type).sort();
    const declaredTypes = [...RENDERER_PAYLOAD_TYPES].sort();
    expect(exampleTypes).toEqual(declaredTypes);
  });
});

describe('individual example shapes', () => {
  // Spot-check that the examples we ship to stories carry the fields the
  // cards actually read — guards against silent rot if someone edits the
  // examples without updating the cards.
  it('JOB_STATUS_EXAMPLE has progress + detail', () => {
    expect(JOB_STATUS_EXAMPLE.progress).toBe(72);
    expect(JOB_STATUS_EXAMPLE.detail).toContain('Compiling');
  });

  it('CONSOLE_STREAM_EXAMPLE has 5+ lines with severities', () => {
    expect(CONSOLE_STREAM_EXAMPLE.lines.length).toBeGreaterThanOrEqual(5);
    expect(CONSOLE_STREAM_EXAMPLE.lines.every((l) => !!l.text)).toBe(true);
  });

  it('TERMINAL_SESSION_EXAMPLE has metrics + security sidecar', () => {
    expect(TERMINAL_SESSION_EXAMPLE.metrics?.load).toHaveLength(3);
    expect(TERMINAL_SESSION_EXAMPLE.security?.length).toBeGreaterThan(0);
  });

  it('ERROR_HALT_EXAMPLE carries a recovery prompt + chips', () => {
    expect(ERROR_HALT_EXAMPLE.recovery_prompt).toBeTruthy();
    expect(ERROR_HALT_EXAMPLE.actions?.length).toBeGreaterThan(0);
  });

  it('INLINE_ACTIONS_EXAMPLE caps at 4 chips per SOUL.md', () => {
    expect(INLINE_ACTIONS_EXAMPLE.actions.length).toBeLessThanOrEqual(4);
  });

  it('REACT_CANVAS_EXAMPLE has tsx + deps + bundle_size', () => {
    expect(REACT_CANVAS_EXAMPLE.tsx).toContain('useState');
    expect(REACT_CANVAS_EXAMPLE.deps).toContain('react');
    expect(REACT_CANVAS_EXAMPLE.bundle_size).toBeGreaterThan(0);
  });

  it('QUEUE_CARD_EXAMPLE has at least one waiting_for_input item', () => {
    const waiting = QUEUE_CARD_EXAMPLE.items.filter(
      (i) => i.state === 'waiting_for_input',
    );
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting[0].actions?.length).toBeGreaterThan(0);
  });
});

// Compile-time exhaustiveness — if a new variant is added to
// RendererPayload, this switch will fail TS compilation until you handle
// it. The test body itself is trivial; the value is in the type check.
describe('exhaustive variant coverage', () => {
  it('every variant has a discriminator string', () => {
    for (const example of ALL_RENDERER_EXAMPLES) {
      switch ((example as RendererPayload).type) {
        case 'job-status':
        case 'console-stream':
        case 'terminal-session':
        case 'error-halt':
        case 'inline-actions':
        case 'react-canvas':
        case 'queue-card':
          expect(example.type.length).toBeGreaterThan(0);
          break;
        default: {
          const _exhaustive: never = example;
          throw new Error(`unhandled variant: ${(_exhaustive as RendererPayload).type}`);
        }
      }
    }
  });
});
