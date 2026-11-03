import { describe, it, expect } from 'vitest';
import { redactText, redactValue } from '../../src/worker/redact-text.js';

describe('redactText', () => {
  it('masque les tokens Bearer et sk-', () => {
    expect(redactText('Authorization: Bearer abcdef1234567890 et sk-abcdef1234567890'))
      .toBe('Authorization: [REDACTED] et [REDACTED]');
  });

  it('masque les affectations de secrets', () => {
    expect(redactText('api_key=abc123, token: "def456", password = \'ghi789\''))
      .toBe('api_key=[REDACTED], token: [REDACTED], password = [REDACTED]');
  });

  it('masque les credentials dans les URLs', () => {
    expect(redactText('https://user:pass@example.com/path')).toBe('https://[REDACTED]@example.com/path');
  });
});

describe('redactValue', () => {
  it('expurge récursivement les chaînes sans changer les autres types', () => {
    expect(redactValue({
      text: 'Bearer abcdef1234567890',
      nested: [{ token: 'abc123', count: 2, valid: true }]
    })).toEqual({
      text: '[REDACTED]',
      nested: [{ token: '[REDACTED]', count: 2, valid: true }]
    });
  });
});
