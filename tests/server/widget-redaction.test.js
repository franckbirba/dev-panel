// tests/server/widget-redaction.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initMasterDatabase, createProject, getMasterDatabase } from '../../src/server/db.js';
import {
  redactPII,
  luhnValid,
  compileCustomPatterns,
  loadProjectPatterns,
  redactForProject
} from '../../src/server/widget-redaction.js';

describe('redactPII — built-in patterns', () => {
  it('redacts a Bearer token', () => {
    const r = redactPII('Authorization: Bearer abc123.def-ghi_456');
    expect(r.text).toBe('Authorization: [REDACTED]');
    expect(r.count).toBe(1);
    expect(r.types).toContain('bearer_token');
  });

  it('redacts an sk- API token', () => {
    const r = redactPII('my key is sk-AbCd1234XYZ');
    expect(r.text).toBe('my key is [REDACTED]');
    expect(r.count).toBe(1);
    expect(r.types).toContain('sk_token');
  });

  it('redacts an email address', () => {
    const r = redactPII('contact alice@example.com please');
    expect(r.text).toBe('contact [REDACTED] please');
    expect(r.count).toBe(1);
    expect(r.types).toContain('email');
  });

  it('redacts a Luhn-valid credit card', () => {
    // 4111 1111 1111 1111 is the canonical Visa test number (Luhn-valid).
    const r = redactPII('paid with 4111 1111 1111 1111 last night');
    expect(r.text).toBe('paid with [REDACTED] last night');
    expect(r.count).toBe(1);
    expect(r.types).toContain('credit_card');
  });

  it('does NOT redact a 16-digit run that fails Luhn', () => {
    const r = redactPII('order id 1234567890123456');
    expect(r.text).toBe('order id 1234567890123456');
    expect(r.count).toBe(0);
  });

  it('redacts a US-style SSN', () => {
    const r = redactPII('SSN 123-45-6789');
    expect(r.text).toBe('SSN [REDACTED]');
    expect(r.count).toBe(1);
    expect(r.types).toContain('ssn');
  });

  it('redacts multiple PII types in one message', () => {
    const r = redactPII('token Bearer xyz mail bob@x.io');
    expect(r.text).toBe('token [REDACTED] mail [REDACTED]');
    expect(r.count).toBe(2);
    expect(r.types).toEqual(expect.arrayContaining(['bearer_token', 'email']));
  });

  it('returns empty result for non-string input', () => {
    expect(redactPII(null)).toEqual({ text: '', count: 0, types: [] });
    expect(redactPII(undefined)).toEqual({ text: '', count: 0, types: [] });
    expect(redactPII(42).count).toBe(0);
  });

  it('passes through clean text untouched', () => {
    const r = redactPII('hello world, no secrets here');
    expect(r.text).toBe('hello world, no secrets here');
    expect(r.count).toBe(0);
    expect(r.types).toEqual([]);
  });
});

describe('luhnValid', () => {
  it('accepts a known valid card', () => {
    expect(luhnValid('4111111111111111')).toBe(true); // Visa test
    expect(luhnValid('5500000000000004')).toBe(true); // MasterCard test
  });

  it('rejects invalid digit sequences', () => {
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('1234567890123456')).toBe(false);
  });

  it('rejects non-digit input and out-of-range lengths', () => {
    expect(luhnValid('abc')).toBe(false);
    expect(luhnValid('12345')).toBe(false);
    expect(luhnValid('12345678901234567890')).toBe(false);
  });
});

describe('redactPII — custom patterns', () => {
  it('applies custom regex strings on top of built-ins', () => {
    const custom = compileCustomPatterns(['INTERNAL-\\d+']);
    const r = redactPII('see ticket INTERNAL-42 and bob@x.io', custom);
    expect(r.text).toBe('see ticket [REDACTED] and [REDACTED]');
    expect(r.count).toBe(2);
  });

  it('skips invalid regex strings without crashing', () => {
    const custom = compileCustomPatterns(['(unbalanced', 'OK\\d+']);
    expect(custom).toHaveLength(1);
    const r = redactPII('OK1 OK99', custom);
    expect(r.text).toBe('[REDACTED] [REDACTED]');
  });

  it('treats non-array input as empty pattern list', () => {
    expect(compileCustomPatterns(null)).toEqual([]);
    expect(compileCustomPatterns('foo')).toEqual([]);
    expect(compileCustomPatterns({})).toEqual([]);
  });
});

describe('loadProjectPatterns / redactForProject', () => {
  let project;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'devpanel-redact-cfg-'));
    initMasterDatabase(tmp);
    project = createProject({ name: 'redact-cfg', github_owner: 'o', github_repo: 'r' });
  });

  it('returns [] when widget_pii_patterns is null', () => {
    expect(loadProjectPatterns(project.id)).toEqual([]);
  });

  it('compiles patterns stored as a JSON array on the project row', () => {
    const db = getMasterDatabase();
    db.prepare('UPDATE projects SET widget_pii_patterns = ? WHERE id = ?')
      .run(JSON.stringify(['SECRET-\\w+', 'foo[0-9]+']), project.id);

    const compiled = loadProjectPatterns(project.id);
    expect(compiled).toHaveLength(2);

    const r = redactForProject(project.id, 'SECRET-AB and foo42');
    expect(r.text).toBe('[REDACTED] and [REDACTED]');
    expect(r.count).toBe(2);
  });

  it('returns [] when widget_pii_patterns is malformed JSON', () => {
    const db = getMasterDatabase();
    db.prepare('UPDATE projects SET widget_pii_patterns = ? WHERE id = ?')
      .run('not json', project.id);
    expect(loadProjectPatterns(project.id)).toEqual([]);
  });
});
