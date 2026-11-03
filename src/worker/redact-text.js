const SIMPLE_SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /sk-[A-Za-z0-9_-]{8,}/g
];
const SECRET_ASSIGNMENT = /\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const URL_CREDENTIALS = /\/\/[^\s/:]+:[^\s@]+@/g;

export function redactText(value) {
  let output = String(value);
  for (const pattern of SIMPLE_SECRET_PATTERNS) {
    output = output.replace(pattern, '[REDACTED]');
  }
  output = output.replace(SECRET_ASSIGNMENT, (match, key, separator) => `${key}${separator}[REDACTED]`);
  return output.replace(URL_CREDENTIALS, '//[REDACTED]@');
}

const SENSITIVE_KEYS = new Set(['api_key', 'apikey', 'token', 'secret', 'password', 'authorization']);

export function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SENSITIVE_KEYS.has(key.toLowerCase()) && typeof nested === 'string'
          ? '[REDACTED]'
          : redactValue(nested)
      ])
    );
  }
  return value;
}
