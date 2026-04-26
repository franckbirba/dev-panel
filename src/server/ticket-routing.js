// src/server/ticket-routing.js
// Idempotent: if a ticket already has routed_label, returns the existing
// routing without changing it. This protects against duplicate [ticket-new]
// fires (deploy churn, Shelly retry) — Shelly checks already_routed and
// skips the DM in that case.

import { getTicket, setTicketRouting, getTicketRouting } from './db.js';
import { resolveLabel, findMember } from './team.js';

export async function routeTicket(storagePath, projectId, ticketId, label) {
  const ticket = getTicket(storagePath, projectId, ticketId);
  if (!ticket) throw new Error(`ticket ${ticketId} not found`);

  // Idempotency: a ticket is "routed" only once it has BOTH a label AND a
  // member id. The widget can pre-write routed_label at submission time when
  // the user picks a category (Task 7); that's not yet a routing decision —
  // Shelly still has to resolve the label to a member and DM them.
  const prior = getTicketRouting(storagePath, projectId, ticketId);
  if (prior && prior.routed_label && prior.routed_member_id) {
    const member = await findMember(prior.routed_member_id);
    if (!member || !member.dev_bot) return null;
    return {
      ticket_id: ticketId,
      label: prior.routed_label,
      member: {
        id: member.id,
        name: member.display_name,
        tg_user_id: member.tg_user_id
      },
      dev_bot: {
        label: member.dev_bot.label,
        username: member.dev_bot.username,
        tg_user_id: member.tg_user_id
      },
      already_routed: true
    };
  }

  // If the widget pre-wrote routed_label (user picked a category), that
  // wins over whatever Shelly proposed.
  const effectiveLabel = (prior && prior.routed_label) ? prior.routed_label : label;

  const resolved = await resolveLabel(projectId, effectiveLabel);
  if (!resolved) return null;

  setTicketRouting(storagePath, projectId, ticketId, {
    label: effectiveLabel,
    member_id: resolved.member.id
  });

  return {
    ticket_id: ticketId,
    label: effectiveLabel,
    member: {
      id: resolved.member.id,
      name: resolved.member.display_name,
      tg_user_id: resolved.member.tg_user_id
    },
    dev_bot: {
      label: resolved.dev_bot.label,
      username: resolved.dev_bot.username,
      tg_user_id: resolved.member.tg_user_id
    },
    already_routed: false
  };
}
