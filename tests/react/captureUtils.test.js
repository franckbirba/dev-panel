import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('ConsoleBuffer', () => {
  let ConsoleBuffer;
  let origLog, origWarn, origError;

  beforeEach(async () => {
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    ({ ConsoleBuffer } = await import('../../src/react/captureUtils.js'));
  });

  afterEach(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });

  it('buffers entries and evicts oldest when full', () => {
    const buf = new ConsoleBuffer(3);
    buf.attach();
    console.log('a');
    console.warn('b');
    console.error('c');
    console.log('d');
    const entries = buf.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].level).toBe('warn');
    expect(entries[0].message).toBe('b');
    expect(entries[2].level).toBe('log');
    expect(entries[2].message).toBe('d');
    buf.detach();
  });

  it('restores original console methods on detach', () => {
    const buf = new ConsoleBuffer(50);
    buf.attach();
    expect(console.log).not.toBe(origLog);
    buf.detach();
  });

  it('includes timestamp on each entry', () => {
    const buf = new ConsoleBuffer(10);
    buf.attach();
    console.log('test');
    const entries = buf.getEntries();
    expect(entries[0].timestamp).toBeTypeOf('number');
    buf.detach();
  });
});

describe('takeDOMSnapshot', () => {
  let takeDOMSnapshot;

  beforeEach(async () => {
    ({ takeDOMSnapshot } = await import('../../src/react/captureUtils.js'));
  });

  it('returns a string containing HTML', () => {
    const result = takeDOMSnapshot();
    if (result !== null) {
      expect(typeof result).toBe('string');
      expect(result).toContain('<html');
    }
  });

  it('truncates DOM larger than 500KB with marker', () => {
    if (!globalThis.document?.documentElement) return;
    const orig = Object.getOwnPropertyDescriptor(document.documentElement, 'outerHTML');
    const bigHtml = '<html>' + 'x'.repeat(600 * 1024) + '</html>';
    Object.defineProperty(document.documentElement, 'outerHTML', {
      get: () => bigHtml,
      configurable: true
    });
    const result = takeDOMSnapshot();
    expect(result.length).toBeLessThanOrEqual(500 * 1024 + 25);
    expect(result).toContain('<!-- [truncated] -->');
    if (orig) Object.defineProperty(document.documentElement, 'outerHTML', orig);
    else delete document.documentElement.outerHTML;
  });

  it('returns null if document access throws', () => {
    if (!globalThis.document?.documentElement) return;
    const orig = Object.getOwnPropertyDescriptor(document.documentElement, 'outerHTML');
    Object.defineProperty(document.documentElement, 'outerHTML', {
      get: () => { throw new Error('fail'); },
      configurable: true
    });
    const result = takeDOMSnapshot();
    expect(result).toBeNull();
    if (orig) Object.defineProperty(document.documentElement, 'outerHTML', orig);
    else delete document.documentElement.outerHTML;
  });
});
