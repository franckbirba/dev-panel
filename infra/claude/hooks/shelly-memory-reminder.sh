#!/bin/bash
# PostToolUse hook for Shelly — nudges her toward memory_search/memory_write
# right after she performs a dispatch/cancel action.
#
# Input (stdin JSON):  {tool_name, tool_input, tool_result, ...}
# Output (stdout JSON): {hookSpecificOutput: {additionalContext: "..."}}
#
# Context comes back to Claude as a system-reminder in the conversation — she
# sees it in the same turn where she just acted, which is when memory writes
# are most useful (args still fresh, decision still un-rationalised).

set -euo pipefail

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // ""')

# Build a short, tool-specific reminder. Keep messages conversational so Claude
# doesn't treat them as noise — the shape of these prompts matters.
case "$tool_name" in
  *plane_dispatch_work_item|*devpanel_workflow_dispatch)
    wid=$(echo "$input" | jq -r '.tool_input.work_item_id // .tool_input.id // ""')
    msg="Tu viens de dispatcher ${wid:-un work item}. Si t'avais pas déjà cherché la mémoire avant, c'est le moment de le faire pour signaler à Franck tout contexte utile (précédent blocage, décision en vigueur). Et si cette action elle-même est non-triviale (priorité forcée, choix entre plusieurs candidats), écris un memory_write kind:decision avec work_item_id pour que la prochaine session sache pourquoi."
    ;;
  *enqueue_job)
    agent=$(echo "$input" | jq -r '.tool_input.agent // ""')
    msg="enqueue_job (agent=${agent:-?}) fait. Rappel : le tool standard pour un work-item est plane_dispatch_work_item — enqueue_job est réservé aux tâches d'agent hors work-item. Si ce job représente une décision (choix d'agent, override de priorité), memory_write kind:decision."
    ;;
  *cancel_job)
    jid=$(echo "$input" | jq -r '.tool_input.job_id // ""')
    msg="Job ${jid:-?} cancel. Un cancel est quasi-toujours une décision — écris un memory_write kind:decision qui dit pourquoi (redondant? mauvais payload? changement de plan?). Sinon demain personne ne saura pourquoi ce job a été stoppé."
    ;;
  *create_work_item)
    msg="Nouveau work item Plane créé. Si c'était la promotion d'une capture, n'oublie pas le PATCH /api/captures/:id status=promoted avec plane_work_item_id. Et un memory_write kind:decision avec work_item_id + tags:[\"promoted\"] pour garder la trace du pourquoi."
    ;;
  *)
    # Not a tool we nudge on — emit nothing, exit clean.
    exit 0
    ;;
esac

# additionalContext is the PostToolUse field that injects a system-reminder
# into the next turn without blocking anything.
jq -n --arg msg "$msg" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $msg
  }
}'
