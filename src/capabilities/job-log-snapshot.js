import { z } from 'zod';
import { listEvents } from '../server/jobs-events.js';
import { pool } from '../server/pg.js';

// Snapshot the last N persisted events for a BullMQ job. Reads
// `agent_job_events` directly via the shared pg pool — no SSH, no admin
// HTTP hop — so this works from both the chat backend (devpanel-api) and
// Shelly's MCP. The complement to `tail_log_snapshot` which targets
// journalctl on hosts the chat container can't SSH into.
//
// Falls back to `agent_job_stderr` for stderr lines when present. The
// worker writes stream-parsed events to `agent_job_events` (see
// src/worker/stream-parser.js) and any raw stderr from the `claude -p`
// subprocess to `agent_job_stderr` when configured.

const STDERR_TABLE_PROBED = { value: false, exists: false };
async function hasStderrTable() {
  if (STDERR_TABLE_PROBED.value) return STDERR_TABLE_PROBED.exists;
  try {
    const { rows } = await pool.query(
      `SELECT 1
         FROM information_schema.tables
        WHERE table_name = 'agent_job_stderr'
        LIMIT 1`,
    );
    STDERR_TABLE_PROBED.exists = rows.length > 0;
  } catch {
    STDERR_TABLE_PROBED.exists = false;
  }
  STDERR_TABLE_PROBED.value = true;
  return STDERR_TABLE_PROBED.exists;
}

export const jobLogSnapshot = {
  name: 'job_log_snapshot',
  description:
    'Last N persisted events for a BullMQ job (from agent_job_events) plus optional stderr tail. Use when Franck (or a chat user) asks "show me the log of job X" — the FleetRowCard Tail chip wires here. Works from the dashboard chat (no SSH needed).',
  paramSchema: z.object({
    job_id: z.string().describe('BullMQ job id'),
    lines: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe('How many tail lines to return (1-500).'),
    include_stderr: z
      .boolean()
      .default(true)
      .describe('Append the stderr tail when an agent_job_stderr table exists.'),
  }),
  renderHint: 'RuntimeConsole',
  async handler({ job_id, lines = 50, include_stderr = true }) {
    // listEvents returns the *first* `limit` events since `after`; we want
    // the *last* N. Pull a wider window then slice. The events table is
    // append-only with a monotonic `seq`, so this is cheap.
    const all = await listEvents(job_id, { after: -1, limit: 10_000 });
    const tail = all.slice(-lines);

    const formatted = tail.map((row) => {
      let summary = '';
      try {
        const p =
          typeof row.payload_json === 'string'
            ? JSON.parse(row.payload_json)
            : row.payload_json;
        // Compact one-line projection: prefer text/title/message fields
        // when present so the RuntimeConsoleCard reads like real logs.
        summary =
          p?.text ??
          p?.message ??
          p?.title ??
          p?.summary ??
          JSON.stringify(p).slice(0, 200);
      } catch {
        summary = String(row.payload_json ?? '').slice(0, 200);
      }
      const ts = row.created_at ? `[${row.created_at}] ` : '';
      const kind = row.event_subtype
        ? `${row.event_type}/${row.event_subtype}`
        : row.event_type;
      return `${ts}${kind}: ${summary}`;
    });

    let stderrTail = [];
    if (include_stderr && (await hasStderrTable())) {
      try {
        const { rows } = await pool.query(
          `SELECT seq, line, created_at
             FROM agent_job_stderr
            WHERE job_id = $1
            ORDER BY seq DESC
            LIMIT $2`,
          [String(job_id), Math.min(lines, 200)],
        );
        stderrTail = rows
          .reverse()
          .map((r) => `[stderr] ${r.line ?? ''}`.trim());
      } catch {
        // Table exists but query failed — log nothing, fall through.
      }
    }

    return {
      job_id,
      title: `job ${job_id}`,
      state: 'connected',
      lines: [...formatted, ...stderrTail],
      total_events: all.length,
      stderr_count: stderrTail.length,
    };
  },
};
