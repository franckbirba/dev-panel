// Pure parser/builder for the dashboard ↔ Telegram thread tag protocol.
//
// Format: `[thread:<subject_type>/<subject_id>] <body>`
//
// The tag MUST start at character 0. Untagged messages stay in the freeform
// Shelly tab; degrades gracefully when Shelly forgets to tag.

const VALID_TYPES = new Set(['work_item', 'capture', 'ticket', 'pr', 'deploy', 'job']);
const TAG_RE = /^\[thread:([a-z_]+)\/([^\]\s]+)\]\s?/;

export function parseTag(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(TAG_RE);
  if (!m) return null;
  const [, subject_type, subject_id] = m;
  if (!VALID_TYPES.has(subject_type)) return null;
  return {
    subject_type,
    subject_id,
    body: text.slice(m[0].length)
  };
}

export function buildTag(subject_type, subject_id) {
  return `[thread:${subject_type}/${subject_id}]`;
}

export function prependTag(subject_type, subject_id, body) {
  return `${buildTag(subject_type, subject_id)} ${body}`;
}
