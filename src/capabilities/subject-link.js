// Write a typed edge between two subjects in the studio graph.
//
// Use whenever you discover a relationship that wasn't auto-populated:
//   - You created an AFFiNE doc about ZENO-42 → write
//     (work_item:ZENO-42) -[documented_in]-> (affine_doc:zeno/<id>).
//   - You spotted a duplicate capture → write
//     (capture:47) -[duplicate_of]-> (capture:38).
//   - You decided in a memory entry that DEVPA-93 blocks DEVPA-100 →
//     write the blocks edge.
//
// Auto-population covers capture→work_item (promote_capture),
// work_item→pr (merge-coordinator webhook), capture→glitchtip_issue
// (bridge endpoint). Everything else is manual via this tool.

import { z } from 'zod';
import { adminPost } from './_http.js';

const SUBJECT_TYPES = [
  'capture',
  'work_item',
  'plane_page',
  'affine_doc',
  'pr',
  'commit',
  'glitchtip_issue',
  'fleet_job',
  'thread',
  'memory',
  'auto_decision',
  'deploy',
];

const RELATIONS = [
  'promoted_to',
  'reports',
  'fixed_by',
  'implements',
  'ran_as',
  'merged_as',
  'documented_in',
  'references',
  'blocks',
  'duplicate_of',
  'regressed_by',
  'retroed_in',
  'decided_in',
];

export const subjectLink = {
  name: 'subject_link',
  description:
    'Write a typed edge between two subjects in the studio graph. Use to record relationships you discover (duplicate captures, doc-about-WI, blocking, references). Auto-populated edges (promote_capture, merge-coordinator, glitchtip bridge) do not need manual writes. Idempotent — same edge twice is a no-op.',
  paramSchema: z.object({
    from_type: z.enum(SUBJECT_TYPES),
    from_id: z.string(),
    to_type: z.enum(SUBJECT_TYPES),
    to_id: z.string(),
    rel: z.enum(RELATIONS),
    meta: z.record(z.string(), z.any()).optional().describe('Free-form JSON sidecar context.'),
  }),
  renderHint: 'SubjectLink',
  async handler({ from_type, from_id, to_type, to_id, rel, meta }) {
    return await adminPost('/api/admin/subject-links', {
      from_type,
      from_id,
      to_type,
      to_id,
      rel,
      source: 'shelly',
      meta: meta ?? null,
    });
  },
};
