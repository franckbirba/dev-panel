---
name: agent-designer
description: Designer Agent - Create wireframes/mockups in Penpot, extract design tokens
---

# Designer Agent — Penpot Wireframes & Design Tokens

**Trigger**: `design:sprint` BullMQ job (on-demand from PM Agent)

**MCP Access**: Penpot (read/write), AFFiNE (read specs), Plane (update status)

**Responsibilities**:
1. Read conception docs from AFFiNE
2. Create wireframes/mockups in Penpot
3. Extract design tokens for dev handoff
4. Wait for Franck's validation
5. Mark work item as "ready-for-dev" in Plane

---

## Step 1: Read Conception Doc from AFFiNE

```javascript
// Get work item details from Plane
const workItem = await mcp__plane__list_work_items({
  project_id: "...",
  filters: { id: workItemId }
})

// Find linked conception doc in AFFiNE
const specDocId = workItem.description.match(/affine:\/\/(.+)/)?.[1]

// Read conception doc
const spec = await mcp__affine__read_doc({
  doc_id: specDocId || "feature-specs/user-auth-flow"
})
```

**Expected content**:
- User stories
- Acceptance criteria
- UX flow description
- Data fields needed
- Edge cases

---

## Step 2: Create Conception Doc (if missing)

If no spec exists, create one in AFFiNE:

```javascript
await mcp__affine__create_doc({
  workspace_id: "9ba536be-bf23-4cbf-87e4-56c7afac6731",
  title: `[Conception] ${workItem.name}`,
  content: `
# Feature: ${workItem.name}

## User Story
As a [user type], I want to [goal], so that [benefit].

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## UX Flow
1. Step 1
2. Step 2

## Data Fields
- Field 1: type, validation
- Field 2: type, validation

## Edge Cases
- Case 1: How to handle?
- Case 2: How to handle?

## Design Notes
- Mobile-first
- Use existing button component
- Color: primary brand color
  `
})
```

**Wait for validation**: Send to Franck for review (VAL_CONCEPTION gate)

---

## Step 3: Create Wireframe in Penpot

**Penpot MCP is at**: `https://penpot-mcp.devpanl.dev/mcp`

```javascript
// List Penpot projects
const projects = await mcp__penpot__list_projects()

// Create new file or use existing project
const file = await mcp__penpot__create_file({
  project_id: projects[0].id,
  name: `${workItem.name} - Wireframe`
})

// Add frames to file
await mcp__penpot__create_frame({
  file_id: file.id,
  page_id: file.pages[0].id,
  name: "Desktop - 1440x900",
  width: 1440,
  height: 900
})

await mcp__penpot__create_frame({
  file_id: file.id,
  page_id: file.pages[0].id,
  name: "Mobile - 375x812",
  width: 375,
  height: 812
})
```

**Note**: Penpot MCP may have limited write capabilities. Check available tools:
- `list_projects`
- `list_files`
- `list_frames`
- `get_design_tokens` (read-only)

**Fallback**: Use Penpot UI directly, then extract via MCP

---

## Step 4: Extract Design Tokens from Penpot

Once mockups are ready in Penpot:

```javascript
const designTokens = await mcp__penpot__get_design_tokens({
  file_id: file.id,
  page_id: page.id
})

// Example output:
// {
//   colors: {
//     primary: "#3B82F6",
//     secondary: "#10B981",
//     background: "#FFFFFF",
//     text: "#1F2937"
//   },
//   typography: {
//     heading: { fontFamily: "Inter", fontSize: 24, fontWeight: 700 },
//     body: { fontFamily: "Inter", fontSize: 16, fontWeight: 400 }
//   },
//   spacing: {
//     xs: 4, sm: 8, md: 16, lg: 24, xl: 32
//   },
//   borderRadius: {
//     sm: 4, md: 8, lg: 12
//   }
// }
```

---

## Step 5: Write Design Tokens to AFFiNE

Create design handoff doc:

```javascript
await mcp__affine__create_doc({
  workspace_id: "9ba536be-bf23-4cbf-87e4-56c7afac6731",
  title: `[Design Tokens] ${workItem.name}`,
  content: `
# Design Tokens — ${workItem.name}

**Penpot File**: [View in Penpot](https://penpot.devpanl.dev/workspace/.../file/${file.id})

## Colors
\`\`\`css
--color-primary: ${designTokens.colors.primary};
--color-secondary: ${designTokens.colors.secondary};
--color-background: ${designTokens.colors.background};
--color-text: ${designTokens.colors.text};
\`\`\`

## Typography
\`\`\`css
--font-heading: ${designTokens.typography.heading.fontFamily}, sans-serif;
--font-body: ${designTokens.typography.body.fontFamily}, sans-serif;
--text-heading: ${designTokens.typography.heading.fontSize}px/${designTokens.typography.heading.lineHeight} var(--font-heading);
\`\`\`

## Spacing
\`\`\`css
--space-xs: ${designTokens.spacing.xs}px;
--space-sm: ${designTokens.spacing.sm}px;
--space-md: ${designTokens.spacing.md}px;
\`\`\`

## Components
- Button: rounded-md, px-4 py-2, bg-primary text-white
- Input: rounded-md, px-3 py-2, border border-gray-300
- Card: rounded-lg, p-6, shadow-md

## Screens
1. Desktop (1440x900): [Frame link]
2. Mobile (375x812): [Frame link]
  `
})
```

---

## Step 6: Request Validation (VAL_MAQUETTE)

Notify Franck via Telegram:

```bash
curl -X POST ${SHELLY_TELEGRAM_WEBHOOK} \
  -H "Content-Type: application/json" \
  -d '{
    "message": "🎨 Mockups ready for validation: ${workItem.name}",
    "validation_type": "maquette",
    "penpot_url": "https://penpot.devpanl.dev/workspace/.../file/${file.id}",
    "affine_tokens_url": "https://affine.devpanl.dev/workspace/.../doc/${tokenDocId}",
    "plane_url": "https://plane.devpanl.dev/devpanl/projects/.../issues/${workItem.id}"
  }'
```

**Wait**: Until Franck validates in Telegram (✅) or requests changes (🔴)

---

## Step 7: Mark as Ready for Dev

Once validated:

```javascript
await mcp__plane__update_work_item({
  work_item_id: workItemId,
  labels: ["ready-for-dev", "design-complete"],
  state: "todo" // Move from backlog to todo
})

// Enqueue build job
await bullmq.add('build:task', {
  work_item_id: workItemId,
  design_tokens_doc_id: tokenDocId,
  penpot_file_id: file.id
})
```

---

## When to Run

**Trigger conditions** (from PM Agent):
- New UI component needed
- Layout change requested
- New screen/page
- Visual redesign
- Design system update

**Frequency**: On-demand (not automated)

---

## Decision Tree

```
design:sprint job received
  ├─ Conception doc exists? NO
  │   ├─ Create conception doc in AFFiNE
  │   └─ Wait for VAL_CONCEPTION ⚠️
  │
  ├─ Conception validated? YES
  │   ├─ Create wireframes in Penpot
  │   ├─ Extract design tokens
  │   └─ Wait for VAL_MAQUETTE ⚠️
  │
  └─ Maquettes validated? YES
      ├─ Write design tokens to AFFiNE
      ├─ Mark Plane work item as "ready-for-dev"
      └─ Enqueue build:task job
```

---

## Penpot MCP Tools Used

- `list_projects` — List all Penpot projects
- `list_files` — Get files in a project
- `list_frames` — Get frames (screens) in a file
- `get_design_tokens` — Extract colors, fonts, spacing

**Note**: Check actual Penpot MCP capabilities at runtime. May need to use Penpot UI + manual export.

---

## AFFiNE MCP Tools Used

- `read_doc` — Read conception specs
- `create_doc` — Create conception/design token docs
- `update_doc` — Append to existing docs

---

## Success Criteria

✅ Conception doc created or updated in AFFiNE  
✅ Mockups created in Penpot (Desktop + Mobile)  
✅ Design tokens extracted and documented  
✅ Franck validates design (VAL_MAQUETTE passes)  
✅ Work item marked "ready-for-dev" in Plane  
✅ build:task job enqueued for Builder agent
