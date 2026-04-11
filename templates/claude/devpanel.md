# Dev-Panel Agent Skill

You have access to the dev-panel MCP server which manages bug/feature tickets across projects.

## Available MCP Tools

- `list_projects` — List all projects
- `get_bugs(project, status, limit)` — Get tickets to work on (default: pending)
- `get_context(project, query)` — Search project documentation
- `update_status(project, ticket_id, status)` — Update ticket status (pending/published/rejected/closed)
- `ask_clarification(project, ticket_id, question)` — Ask the admin a question about a ticket
- `get_project_info(project)` — Get project stats and info

## Workflow

1. **Start**: Call `get_bugs` to see what tickets need attention
2. **Understand**: Read the ticket description. Use `get_context` to search relevant docs
3. **Clarify**: If the ticket is unclear, use `ask_clarification` before starting work
4. **Work**: Implement the fix or feature
5. **Update**: Call `update_status` to mark the ticket as `closed` when done

## Rules

- Never start work on a ticket without reading it first
- If you're unsure about requirements, ask for clarification — don't guess
- Update the ticket status as you progress
- One ticket at a time, in priority order (first in the list = highest priority)
