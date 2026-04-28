// src/server/widget-redaction.js
//
// PII redaction for the widget chat surface (DEVPA-166).
//
// Built-in filters: bearer/sk- tokens, emails, credit-card numbers
// (validated with the Luhn checksum to keep false positives low) and
// US-style SSN. Each project can layer additional regex patterns via
// projects.widget_pii_patterns (JSON array of strings). Replacement
// text is always [REDACTED] so logs and dashboards make the substitution
// explicit.
//
// Order matters: token patterns run first, before the more permissive
// number / digit-sequence rules, so a bearer token that happens to look
// like a long digit run is caught as a token rather than as a card.

import { getMasterDatabase } from './db.js';

const REDACTED = '[REDACTED]';

// Built-in patterns, applied in order. Each entry is { name, re, validate? }.
// `validate(match)` lets a pattern reject false positives (e.g. card-number
// candidates that fail the Luhn check). When validate returns false the
// match is left as-is.
const BUILT_IN_PATTERNS = [
  { name: 'bearer_token', re: /Bearer\s+[A-Za-z0-9._\-]+/g },
  { name: 'sk_token',     re: /\bsk-[A-Za-z0-9]+/g },
  { name: 'email',        re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  // Credit card candidate: 13–19 digits, optionally separated by spaces or
  // dashes. Luhn-validated so a phone number or unrelated long digit run
  // doesn't get clobbered.
  {
    name: 'credit_card',
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (m) => luhnValid(m.replace(/[ -]/g, ''))
  },
  // US SSN: 3-2-4 digit groups separated by dashes or spaces.
  { name: 'ssn', re: /\b\d{3}[ -]\d{2}[ -]\d{4}\b/g }
];

// Luhn algorithm for credit-card validation. Pure digits in, boolean out.
export function luhnValid(digits) {
  if (!/^\d+$/.test(digits)) return false;
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// Compile a project's custom pattern strings into RegExp objects. Bad
// patterns are skipped (not thrown) so a single typo can't disable
// redaction entirely. Returns an array of { name, re } compatible with
// the built-in pattern shape.
export function compileCustomPatterns(rawPatterns) {
  if (!Array.isArray(rawPatterns)) return [];
  const compiled = [];
  for (const entry of rawPatterns) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    try {
      compiled.push({
        name: `custom:${entry.slice(0, 32)}`,
        re: new RegExp(entry, 'g')
      });
    } catch {
      // Invalid regex — skip. Caller shouldn't crash on bad config.
    }
  }
  return compiled;
}

// Apply every pattern in sequence. Returns { text, count, types } where
// `count` is the total number of substitutions and `types` lists the
// distinct pattern names that fired (handy for audit/logging).
export function redactPII(input, customPatterns = []) {
  if (typeof input !== 'string' || input.length === 0) {
    return { text: input ?? '', count: 0, types: [] };
  }

  const all = [...BUILT_IN_PATTERNS, ...customPatterns];
  let text = input;
  let count = 0;
  const types = new Set();

  for (const { name, re, validate } of all) {
    text = text.replace(re, (match) => {
      if (validate && !validate(match)) return match;
      count++;
      types.add(name);
      return REDACTED;
    });
  }

  return { text, count, types: [...types] };
}

// Load a project's custom pattern list from projects.widget_pii_patterns.
// Returns [] when the project has no override or the JSON is malformed.
export function loadProjectPatterns(project_id) {
  const db = getMasterDatabase();
  const row = db.prepare('SELECT widget_pii_patterns FROM projects WHERE id = ?').get(project_id);
  if (!row || !row.widget_pii_patterns) return [];
  let parsed;
  try { parsed = JSON.parse(row.widget_pii_patterns); }
  catch { return []; }
  return compileCustomPatterns(parsed);
}

// Convenience: load + redact in one call. Used by the route layer.
export function redactForProject(project_id, content) {
  const custom = loadProjectPatterns(project_id);
  return redactPII(content, custom);
}
