// Universal subject map — the studio graph traversal.
//
// Given any subject (capture/work_item/pr/etc.), return the constellation
// around it: explicit subject_links edges + summaries of the linked
// subjects so the chat doesn't have to round-trip again to render the
// constellation card.
//
// Design choices:
//   1) ONE round-trip from chat → constellation. The card can drill-in by
//      calling subject_map again on a child node — but the initial render
//      should answer 80% of "what's known about this thing?" without it.
//   2) Capped fan-out. Up to N edges per direction, summaries trimmed to
//      what matters for orientation (title/state/url/age). Full details
//      stay one capability call away (work_item_detail, capture_detail).
//   3) Graceful partial failures. If GlitchTip is down or one Plane call
//      times out, the constellation still renders with the parts we got;
//      missing pieces become `{ error: "..." }` entries so Shelly can
//      tell Franck what's degraded.
//
// Output shape — see CONSTELLATION at the bottom of the file.

import { z } from 'zod';
import { adminGet } from './_http.js';

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

const PER_GROUP_CAP = 20;

// ─── Edge fetchers ──────────────────────────────────────────────────────────

async function fetchEdges(type, id) {
  // Pull both directions in one trip via the admin endpoint's `direction=any`.
  try {
    const params = new URLSearchParams({
      from_type: type,
      from_id: id,
      to_type: type,
      to_id: id,
      direction: 'any',
      limit: '200',
    });
    const data = await adminGet(`/api/admin/subject-links?${params.toString()}`);
    return Array.isArray(data.links) ? data.links : [];
  } catch (e) {
    return { error: e.message, links: [] };
  }
}

// ─── Summary fetchers — short, NEVER throw, return null on failure ─────────

async function summarizeCapture(id) {
  try {
    const data = await adminGet(`/api/admin/captures/${encodeURIComponent(id)}`);
    const c = data.capture || data;
    if (!c) return null;
    return {
      id: c.id,
      type: 'capture',
      project_name: c.project_name,
      kind: c.kind,
      status: c.status,
      content: typeof c.content === 'string' ? c.content.slice(0, 140) : null,
      created_at: c.created_at,
      plane_work_item_id: c.plane_work_item_id ?? null,
      plane_sequence_id: c.plane_sequence_id ?? null,
    };
  } catch {
    return null;
  }
}

// Plane work item summary — mirrors workItemDetail's lookup but kept tiny
// because the constellation may pull in 10+ of these.
async function summarizeWorkItem(id) {
  try {
    // The work_item_detail capability handles SEQ + UUID resolution; we
    // bypass to the admin lookup-by-plane-id when possible. As a robust
    // fallback we just call the existing capability's HTTP cousin via the
    // remote MCP — but to keep dependencies local, embed a minimal direct
    // call. If the resolver here misses, the card will show the bare id.
    // Format-checks let us pick the path:
    const SEQ_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/;
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!SEQ_RE.test(id) && !UUID_RE.test(id)) {
      return { id, type: 'work_item', _note: 'unresolved id format' };
    }
    // Lazy-import to dodge the circular: capabilities ↔ shared http both
    // bottom out here. This works because resolvePlaneWorkItem is in the
    // same _http module, and Node ESM hoists the import OK.
    const { resolvePlaneWorkItem } = await import('./_http.js');
    const wi = await resolvePlaneWorkItem(id);
    if (!wi) return { id, type: 'work_item', _note: 'not found in Plane' };
    return {
      id: wi.id,
      type: 'work_item',
      sequence_id: wi.sequence_id ?? null,
      name: wi.name,
      priority: wi.priority,
      state: wi.state,                            // raw state UUID — card can resolve
      project: wi.project,
      created_at: wi.created_at,
      updated_at: wi.updated_at,
    };
  } catch {
    return { id, type: 'work_item', _note: 'lookup failed' };
  }
}

async function summarizeMemory(id) {
  // No admin endpoint for individual memories — surface the id only;
  // the chat can call memory_search with the title later if needed.
  return { id, type: 'memory' };
}

async function summarizeAutoDecision(id) {
  try {
    const data = await adminGet(`/api/admin/auto-decisions?include_rolled_back=1&limit=200`);
    const row = (data.decisions || []).find(d => String(d.id) === String(id));
    if (!row) return { id, type: 'auto_decision', _note: 'not found' };
    return {
      id: row.id,
      type: 'auto_decision',
      kind: row.kind,
      what: row.what,
      ts: row.ts,
      rolled_back_at: row.rolled_back_at,
    };
  } catch {
    return { id, type: 'auto_decision', _note: 'lookup failed' };
  }
}

async function summarizeFleetJob(id) {
  // The events endpoint is the cheapest peek — gives state + last event.
  try {
    const data = await adminGet(`/api/admin/jobs/${encodeURIComponent(id)}/events?limit=1`);
    const events = data.events || [];
    return {
      id,
      type: 'fleet_job',
      last_event: events[0] || null,
    };
  } catch {
    return { id, type: 'fleet_job' };
  }
}

// PR / commit / plane_page / affine_doc / glitchtip_issue / thread /
// deploy: we don't have first-class admin endpoints for shallow summaries
// of those today. Surface the id only — the card knows how to render the
// linkable forms (github URL, plane page URL, affine URL, dashboard
// thread URL, glitchtip URL).
function shallowOnly(type) {
  return async (id) => ({ id, type });
}

const SUMMARIZERS = {
  capture: summarizeCapture,
  work_item: summarizeWorkItem,
  memory: summarizeMemory,
  auto_decision: summarizeAutoDecision,
  fleet_job: summarizeFleetJob,
  plane_page: shallowOnly('plane_page'),
  affine_doc: shallowOnly('affine_doc'),
  pr: shallowOnly('pr'),
  commit: shallowOnly('commit'),
  glitchtip_issue: shallowOnly('glitchtip_issue'),
  thread: shallowOnly('thread'),
  deploy: shallowOnly('deploy'),
};

async function summarize(type, id) {
  const fn = SUMMARIZERS[type] || shallowOnly(type);
  return await fn(id);
}

// ─── Group edges + dedupe + summarize neighbors ────────────────────────────

async function buildConstellation(centerType, centerId, edges) {
  // Group neighbors by (type, rel-direction). Each entry knows whether it's
  // an incoming or outgoing edge so the card can label "promoted to" vs
  // "promoted from" sensibly.
  const groups = {};
  const seen = new Set();
  for (const e of edges) {
    const isOutgoing = e.from_type === centerType && e.from_id === centerId;
    const otherType = isOutgoing ? e.to_type : e.from_type;
    const otherId = isOutgoing ? e.to_id : e.from_id;
    const key = `${otherType}/${otherId}/${e.rel}/${isOutgoing ? 'out' : 'in'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const groupKey = otherType;
    if (!groups[groupKey]) groups[groupKey] = [];
    if (groups[groupKey].length >= PER_GROUP_CAP) continue;
    groups[groupKey].push({
      direction: isOutgoing ? 'out' : 'in',
      rel: e.rel,
      type: otherType,
      id: otherId,
      source: e.source,
      created_at: e.created_at,
      meta: e.meta,
    });
  }

  // Fan out summaries in parallel, capped per group.
  const summarized = {};
  await Promise.all(
    Object.entries(groups).map(async ([type, items]) => {
      summarized[type] = await Promise.all(
        items.map(async (edge) => ({
          ...edge,
          summary: await summarize(edge.type, edge.id),
        }))
      );
    })
  );
  return summarized;
}

// ─── Capability ────────────────────────────────────────────────────────────

export const subjectMap = {
  name: 'subject_map',
  description:
    'Map the constellation around any subject (capture/work_item/pr/etc.). Returns the center subject\'s summary plus all linked subjects grouped by type, with their own short summaries. ONE call surfaces what would otherwise take 6 separate tool calls (capture_detail + work_item_detail + memory_search + ...). Use as your first move when Franck names a subject — \"où on en est sur ZENO-42?\", \"raconte moi cette capture 47\", \"que sait-on sur la PR #223?\".',
  paramSchema: z.object({
    subject_type: z.enum(SUBJECT_TYPES),
    subject_id: z.string().describe('UUID, sequence id (DEVPA-217), PR ref (owner/repo#NN), or other typed id.'),
  }),
  renderHint: 'SubjectConstellation',
  async handler({ subject_type, subject_id }) {
    // 1) Center summary
    const centerP = summarize(subject_type, subject_id);
    // 2) Edges (both directions) in parallel with center
    const edgesP = fetchEdges(subject_type, subject_id);
    const [center, edgesResult] = await Promise.all([centerP, edgesP]);

    let edges = [];
    let edgesError = null;
    if (Array.isArray(edgesResult)) {
      edges = edgesResult;
    } else if (edgesResult && Array.isArray(edgesResult.links)) {
      edges = edgesResult.links;
    } else if (edgesResult && edgesResult.error) {
      edgesError = edgesResult.error;
    }

    const groups = await buildConstellation(subject_type, subject_id, edges);

    return {
      center: {
        type: subject_type,
        id: subject_id,
        summary: center,
      },
      groups,                          // { [type]: [ { direction, rel, type, id, summary, ... } ] }
      counts: Object.fromEntries(
        Object.entries(groups).map(([t, items]) => [t, items.length])
      ),
      edge_count: edges.length,
      edges_error: edgesError,
    };
  },
};

/*
CONSTELLATION = {
  center: { type, id, summary },
  groups: {
    capture:        [{ direction, rel, type, id, source, created_at, meta, summary }, ...],
    work_item:      [...],
    pr:             [...],
    fleet_job:      [...],
    memory:         [...],
    auto_decision:  [...],
    glitchtip_issue:[...],
    affine_doc:     [...],
    plane_page:     [...],
    thread:         [...],
    deploy:         [...],
  },
  counts: { capture: N, ... },
  edge_count: N,
  edges_error: null | "...",
}
*/
