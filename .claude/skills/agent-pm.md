---
name: agent-pm
description: PM Agent - Triage tickets, manage backlog, assign work items in Plane
---

# PM Agent — Sprint & Backlog Management

**Trigger**: Always runs on `shelly:triage` BullMQ job (every new ticket from DevPanel or Telegram)

**MCP Access**: Plane, AFFiNE, GitHub (read), DevPanel API

**Responsibilities**:
1. Triage incoming tickets from DevPanel
2. Create/update Plane work items
3. Prioritize backlog
4. Assign to sprints/cycles
5. Route to appropriate agents (Architect, Designer, Builder)

---

## Step 1: List Pending DevPanel Tickets

```bash
# Via DevPanel CLI
node bin/dev-panel.js list --status=pending

# Or via DevPanel API
curl -H "X-API-Key: ${ADMIN_API_KEY}" \
  https://devpanl.dev/api/tickets?status=pending
```

**Output**: List of tickets with id, title, type (bug/feature), priority, screenshot

---

## Step 2: Review Ticket Details

```bash
# CLI
node bin/dev-panel.js review <ticket-id>

# API
curl -H "X-API-Key: ${ADMIN_API_KEY}" \
  https://devpanl.dev/api/tickets/<ticket-id>
```

**Analysis**:
- Is it a bug or feature request?
- Does it need design work? → Route to Designer
- Does it need architecture review? → Route to Architect
- Is it ready for dev? → Route to Builder
- Priority level (P0/P1/P2/P3)?

---

## Step 3: Create Plane Work Item

Use Plane MCP to create work item:

```javascript
mcp__plane__create_work_item({
  project_id: "...", // Get from list_projects
  name: "Bug: User can't submit form",
  description: "DevPanel ticket #123\n\nSteps to reproduce:...",
  state: "backlog", // or "todo", "in_progress"
  priority: "high", // low, medium, high, urgent
  labels: ["bug", "frontend", "p1"],
  assignee_id: null, // Assign later
  parent_id: null, // Link to epic if applicable
  estimate_point: 3 // Story points
})
```

---

## Step 4: Check if Architecture Review Needed

**Triggers for Architect agent**:
- New API endpoint
- Database schema change
- New external integration
- Security-sensitive feature
- Performance impact > 10% estimated

**Action**: Enqueue `arch:review` job in BullMQ if needed

```javascript
// Via BullMQ (pseudocode)
await queue.add('arch:review', {
  work_item_id: planeWorkItem.id,
  devpanel_ticket_id: 123,
  reason: "New API endpoint for payment processing"
})
```

---

## Step 5: Check if Design Work Needed

**Triggers for Designer agent**:
- New UI component
- Layout changes
- New screen/page
- Visual redesign
- Design system token change

**Action**: Enqueue `design:sprint` job

```javascript
await queue.add('design:sprint', {
  work_item_id: planeWorkItem.id,
  design_type: "wireframe", // or "mockup", "design-tokens"
  penpot_project_id: "..."
})
```

---

## Step 6: Assign to Sprint/Cycle

List current cycles in Plane:

```javascript
mcp__plane__list_cycles({ project_id: "..." })
```

Update work item to add to current sprint:

```javascript
mcp__plane__update_work_item({
  work_item_id: "...",
  cycle_id: "current-sprint-id"
})
```

---

## Step 7: Update AFFiNE Sprint Board

Read current sprint doc:

```javascript
mcp__affine__read_doc({ 
  doc_id: "sprint-15-backlog" 
})
```

Append new work item to sprint table:

```javascript
mcp__affine__update_doc({
  doc_id: "sprint-15-backlog",
  append: `
| Work Item | Priority | Status | Assignee | Est. |
|-----------|----------|--------|----------|------|
| DEV-123 | P1 | Backlog | Unassigned | 3 pts |
`
})
```

---

## Step 8: Publish to GitHub (if approved)

If ticket is approved for dev:

```bash
node bin/dev-panel.js publish <ticket-id>
```

This creates a GitHub issue and links it to the Plane work item.

---

## Step 9: Notify Franck (Telegram)

If validation required:

```bash
curl -X POST ${SHELLY_TELEGRAM_WEBHOOK} \
  -H "Content-Type: application/json" \
  -d '{
    "message": "🔴 New ticket requires validation: DevPanel #123 → Plane DEV-456",
    "validation_type": "triage",
    "ticket_url": "https://devpanl.dev/tickets/123",
    "plane_url": "https://plane.devpanl.dev/devpanl/projects/.../issues/DEV-456"
  }'
```

---

## When to Run

**Always**: On every `shelly:triage` job (triggered by new DevPanel ticket or Franck's Telegram message)

**Frequency**: Real-time (event-driven via BullMQ)

---

## Decision Tree

```
New DevPanel Ticket
  ├─ Bug?
  │   ├─ Critical (P0) → Assign immediately, notify Franck
  │   ├─ High (P1) → Add to current sprint
  │   └─ Normal (P2/P3) → Add to backlog
  │
  ├─ Feature?
  │   ├─ Has design? NO → Route to Designer agent
  │   ├─ Has ADR? NO → Route to Architect agent
  │   └─ Ready → Add to backlog, assign sprint
  │
  └─ Enhancement?
      ├─ Quick win (<2h) → Add to current sprint
      └─ Otherwise → Prioritize in backlog
```

---

## Plane MCP Tools Used

- `list_projects` — Get project IDs
- `list_work_items` — View current backlog
- `create_work_item` — Create ticket in Plane
- `list_cycles` — Get current sprint
- `list_modules` — Get project modules/epics
- `delete_work_item` — Remove duplicate/invalid tickets

---

## Success Criteria

✅ All DevPanel tickets processed within 5 minutes  
✅ Work items created in Plane with correct priority  
✅ Design/Arch reviews triggered when needed  
✅ Sprint backlog updated in AFFiNE  
✅ Franck notified for validation gates
