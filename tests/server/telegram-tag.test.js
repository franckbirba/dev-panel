import { describe, it, expect } from 'vitest';
import { parseTag, buildTag, prependTag } from '../../src/server/telegram-tag.js';

describe('telegram thread tag', () => {
  it('parses a well-formed tag', () => {
    expect(parseTag('[thread:work_item/ZENO-42] hello')).toEqual({
      subject_type: 'work_item',
      subject_id: 'ZENO-42',
      body: 'hello'
    });
  });

  it('parses tag with multi-word body and trailing newlines', () => {
    expect(parseTag('[thread:capture/cap_abc] line1\nline2')).toEqual({
      subject_type: 'capture',
      subject_id: 'cap_abc',
      body: 'line1\nline2'
    });
  });

  it('returns null on missing tag', () => {
    expect(parseTag('plain message')).toBe(null);
  });

  it('returns null on tag not at start of message', () => {
    expect(parseTag('hello [thread:work_item/X-1] body')).toBe(null);
  });

  it('returns null on unknown subject_type', () => {
    expect(parseTag('[thread:wat/X] body')).toBe(null);
  });

  it('returns null on malformed tag (no closing bracket)', () => {
    expect(parseTag('[thread:work_item/X-1 body')).toBe(null);
  });

  it('builds a tag', () => {
    expect(buildTag('work_item', 'ZENO-42')).toBe('[thread:work_item/ZENO-42]');
  });

  it('prependTag composes tag + body', () => {
    expect(prependTag('work_item', 'ZENO-42', 'hello')).toBe('[thread:work_item/ZENO-42] hello');
  });

  it('roundtrips: parseTag(prependTag(...)) recovers original', () => {
    const tagged = prependTag('capture', 'cap_xyz', 'multi\nline');
    expect(parseTag(tagged)).toEqual({ subject_type: 'capture', subject_id: 'cap_xyz', body: 'multi\nline' });
  });
});
