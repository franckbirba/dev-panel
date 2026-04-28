// src/dashboard/lib/time.js
// Single timeAgo helper that handles every timestamp shape the API returns:
//   - JS number (epoch ms)
//   - BIGINT epoch ms returned by node-postgres as a *string* of digits
//     (workflow_instances.last_event_at, .started_at, .exhausted_at,
//     agent_job_log.timestamp)
//   - ISO 8601 strings ("2026-04-28T05:53:04Z")
//   - SQLite "YYYY-MM-DD HH:MM:SS" without timezone (treated as UTC)
//
// Returns "—" for missing values, "now" / "Nm" / "Nh" / "Nd" for relative
// distance from now. The numeric-string branch is the load-bearing one —
// without it BIGINT timestamps render as "—" everywhere they're used.
export function timeAgo(input) {
  if (input == null || input === '') return '—';
  let ts;
  if (typeof input === 'number') {
    ts = input;
  } else if (/^\d+$/.test(String(input).trim())) {
    ts = parseInt(String(input).trim(), 10);
  } else {
    const s = String(input);
    ts = Date.parse(s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z'));
  }
  if (!Number.isFinite(ts)) return '—';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return diffSec < 5 ? 'now' : `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}
