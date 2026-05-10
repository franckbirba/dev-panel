// src/server/notify-routing.js
// Studio-wide event routing — flat config (not a table for 6 rules).
// Spec: docs/superpowers/specs/2026-05-09-agent-interactivity-v2-design.md (Step 5)
//
// notifyEvent(kind, payload) consults this map to decide who to DM.
// Resolution rules per route:
//   dm: 'requester'              → use payload.requester_tg_user_id (the
//                                   human the agent is paused on, or the
//                                   actor that triggered the event).
//   dm: 'all_active'             → every studio_members row.
//   dm: 'all_with_can_deploy'    → studio_members WHERE can_deploy=TRUE.
//   dm: 'project_members'        → studio_members WHERE project ∈ projects[].
//                                   Requires payload.project to be set.
//   dm: { tg_user_id: '...' }    → escape hatch, hardcoded.
//   dm: null                      → don't DM anyone (silent route).
//
// `topic: '#deploys'` etc are intentionally accepted but a no-op in v2 —
// the supergroup ships in Step 6 with the same code path. Today only the
// `dm:` field actually fires.
//
// Promote to a Postgres table (telegram_routing) the day a non-Franck
// human edits routes — until then, edit-in-PR is the audit trail.

export const ROUTES = {
  // Studio facts
  morning_digest:     { dm: 'all_active',           topic: '#general'  },
  deploy:             { dm: 'all_with_can_deploy',  topic: '#deploys'  },
  pr_shipped:         { dm: 'project_members',      topic: 'project'   },
  glitchtip_error:    { dm: 'project_members',      topic: '#deploys'  },
  capture_promoted:   { dm: 'project_members',      topic: '#captures' },
  workflow_completed: { dm: 'requester',            topic: 'project'   },

  // Personal decisions (HITL stays DM-routed)
  await_human:        { dm: 'requester',            topic: null        },
  tool_approval:      { dm: 'requester',            topic: null        },
  pair_dev_bot:       { dm: { bot_label: 'franck' }, topic: null       },
};

// Resolve a route + payload to the set of tg_user_ids that should receive
// this notification. Returns string[] (tg_user_id values).
export async function resolveRecipients({ kind, payload, studio }) {
  const route = ROUTES[kind];
  if (!route || route.dm == null) return [];

  if (typeof route.dm === 'object') {
    if (route.dm.tg_user_id) return [String(route.dm.tg_user_id)];
    if (route.dm.bot_label) {
      const m = await studio.getByBotLabel(route.dm.bot_label);
      return m ? [m.tg_user_id] : [];
    }
    return [];
  }

  switch (route.dm) {
    case 'all_active': {
      const members = await studio.listMembers();
      return members.map(m => m.tg_user_id);
    }
    case 'all_with_can_deploy': {
      const members = await studio.listDeployers();
      return members.map(m => m.tg_user_id);
    }
    case 'project_members': {
      if (!payload?.project) return [];
      const members = await studio.listMembersOnProject(payload.project);
      return members.map(m => m.tg_user_id);
    }
    case 'requester': {
      const id = payload?.requester_tg_user_id;
      return id ? [String(id)] : [];
    }
    default:
      return [];
  }
}

// resolveDestinations — extends resolveRecipients with the matching
// default_dm_chat_id per recipient (so the caller can sendMessage
// directly without re-querying studio_members). Returns
// [{ tg_user_id, chat_id }].
export async function resolveDestinations({ kind, payload, studio }) {
  const ids = await resolveRecipients({ kind, payload, studio });
  if (ids.length === 0) return [];
  const out = [];
  for (const id of ids) {
    const m = await studio.getByTgUserId(id);
    if (!m) continue;
    out.push({
      tg_user_id: m.tg_user_id,
      chat_id: m.default_dm_chat_id,
      display_name: m.display_name,
    });
  }
  return out;
}
