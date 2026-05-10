// Boss-COS audit trail capabilities.
//
// auto_decision_log — Shelly writes here every time she takes a reversible
//   action without asking. The dashboard's AutoDecisionsPanel renders these
//   so Franck can see what she did overnight and rollback any of it.
//
// decisions_log — read-side; Shelly can recall recent auto-decisions when
//   Franck asks "qu'est-ce que t'as fait sans moi aujourd'hui?".
//
// Storage in `auto_decisions` table (src/server/db.js).
// Admin REST twin in src/server/routes.js (POST + GET + rollback).

import { z } from 'zod';
import { adminPost, adminGet } from './_http.js';

export const autoDecisionLog = {
  name: 'auto_decision_log',
  description:
    'Log a decision Shelly took without asking Franck. Use ONLY for reversible actions — anything destructive or visible externally must be asked first. Per the Boss-COS protocol in SOUL.md. Returns the inserted row id.',
  paramSchema: z.object({
    kind: z
      .enum([
        'drop_capture',
        'mark_triaging',
        'dispatch_nightly',
        'restart_service',
        'cancel_overbudget',
        'patch_promoted',
        'minor_correction',
        'misc',
      ])
      .describe('Bucket for the decision. Pick the closest match; use "misc" only as a last resort.'),
    what: z.string().describe('One-sentence human description: "Dropped capture 47 — duplicate of ZENO-38".'),
    why: z.string().optional().describe('Short reason if not obvious from `what`.'),
    undo_hint: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        'Machine-readable hint for rollback. Example for drop_capture: {"target":"capture/47","action":"set_status","value":"new"}.'
      ),
    project_id: z.string().optional().describe('Devpanel project id if scoped to one project.'),
  }),
  renderHint: 'AutoDecision',
  async handler({ kind, what, why, undo_hint, project_id }) {
    const r = await adminPost('/api/admin/auto-decisions', {
      kind,
      what,
      why: why ?? null,
      undo_hint: undo_hint ?? null,
      project_id: project_id ?? null,
    });
    return r;
  },
};

export const decisionsLog = {
  name: 'decisions_log',
  description:
    'List recent auto-decisions Shelly took without asking. Use when Franck asks "qu\'est-ce que t\'as fait sans moi?" or before answering "rollback X" to find the row.',
  paramSchema: z.object({
    since: z
      .string()
      .optional()
      .describe('ISO timestamp; defaults to 24h ago.'),
    limit: z.number().int().min(1).max(200).default(50),
    project_id: z.string().optional(),
    include_rolled_back: z.boolean().default(false),
  }),
  renderHint: 'AutoDecisionList',
  async handler({ since, limit = 50, project_id, include_rolled_back = false }) {
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    if (project_id) params.set('project_id', project_id);
    if (include_rolled_back) params.set('include_rolled_back', '1');
    params.set('limit', String(limit));
    const data = await adminGet(`/api/admin/auto-decisions?${params.toString()}`);
    return { decisions: data.decisions || [] };
  },
};
