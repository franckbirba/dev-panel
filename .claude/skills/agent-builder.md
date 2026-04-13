---
name: agent-builder
description: Builder Agent - Write code, create PRs, update Plane work items
---

# Builder Agent — Code Implementation & PR Creation

**Trigger**: `build:task` BullMQ job (from PM or Designer agent)

**MCP Access**: AFFiNE (read specs/tokens), Penpot (read frames), Plane (update status), GitHub (create PR)

**Concurrency**: Multiple builder agents can run in parallel (×N)

**Responsibilities**:
1. Read specs from AFFiNE
2. Read design tokens/mockups from Penpot
3. Implement feature/bugfix
4. Write tests
5. Create GitHub PR
6. Update Plane work item status

---

## Step 1: Get Work Item Details

```javascript
const workItem = await mcp__plane__list_work_items({
  project_id: "...",
  filters: { id: workItemId }
})

// workItem contains:
// - name: "Add user authentication flow"
// - description: "..." (may include links to AFFiNE docs, Penpot files)
// - labels: ["ready-for-dev", "frontend", "p1"]
// - estimate_point: 3
```

---

## Step 2: Read Specs from AFFiNE

Extract AFFiNE doc links from work item description:

```javascript
const specLinks = workItem.description.match(/affine:\/\/(.+?)(?:\s|$)/g) || []

for (const link of specLinks) {
  const docId = link.replace('affine://', '').trim()
  const spec = await mcp__affine__read_doc({ doc_id: docId })
  
  console.log('Spec:', spec.title)
  console.log('Content:', spec.content)
}
```

Expected docs:
- **Conception doc**: User stories, acceptance criteria, UX flow
- **Design tokens doc**: CSS variables, component specs

---

## Step 3: Read Design Assets from Penpot

If design work exists:

```javascript
const penpotFileId = workItem.description.match(/penpot:\/\/(.+?)(?:\s|$)/)?.[1]

if (penpotFileId) {
  const frames = await mcp__penpot__list_frames({
    file_id: penpotFileId,
    page_id: '...' // Get from list_files first
  })
  
  const tokens = await mcp__penpot__get_design_tokens({
    file_id: penpotFileId,
    page_id: '...'
  })
  
  console.log('Design tokens:', tokens)
  console.log('Frames:', frames.map(f => f.name))
}
```

---

## Step 4: Update Plane Work Item to "In Progress"

```javascript
await mcp__plane__update_work_item({
  work_item_id: workItemId,
  state: "in_progress",
  assignee_id: "builder-agent-id" // Or null if automated
})
```

---

## Step 5: Implement Feature

**Using Claude Code tools**:

```bash
# Create feature branch
git checkout -b feature/DEV-${workItem.id}-auth-flow

# Read existing code
cat src/components/Auth/LoginForm.jsx

# Write new component based on design tokens
# (Use design tokens from AFFiNE doc)

# Example: Create LoginForm component
cat > src/components/Auth/LoginForm.jsx << 'EOF_CODE'
import React from 'react';

export function LoginForm({ onSubmit }) {
  return (
    <form 
      onSubmit={onSubmit}
      className="rounded-lg p-6 shadow-md"
      style={{
        '--color-primary': '#3B82F6',
        '--space-md': '16px'
      }}
    >
      <input 
        type="email" 
        placeholder="Email"
        className="rounded-md px-3 py-2 border border-gray-300"
      />
      <button 
        type="submit"
        className="rounded-md px-4 py-2 bg-primary text-white"
      >
        Sign In
      </button>
    </form>
  );
}
EOF_CODE

# Run linter
npm run lint

# Run tests
npm run test -- --testPathPattern=LoginForm
```

---

## Step 6: Write Tests

```javascript
// Create test file
cat > src/components/Auth/LoginForm.test.jsx << 'EOF_TEST'
import { render, screen } from '@testing-library/react';
import { LoginForm } from './LoginForm';

test('renders email input', () => {
  render(<LoginForm onSubmit={() => {}} />);
  expect(screen.getByPlaceholderText('Email')).toBeInTheDocument();
});

test('renders submit button', () => {
  render(<LoginForm onSubmit={() => {}} />);
  expect(screen.getByText('Sign In')).toBeInTheDocument();
});
EOF_TEST

npm run test
```

---

## Step 7: Create GitHub PR

```bash
# Commit changes
git add .
git commit -m "feat(auth): add login form component

Implements DEV-${workItem.id}

- Add LoginForm component with email/password fields
- Apply design tokens from Penpot mockup
- Add unit tests for form rendering

Plane: https://plane.devpanl.dev/devpanl/projects/.../issues/DEV-${workItem.id}
AFFiNE Spec: https://affine.devpanl.dev/workspace/.../doc/...
Penpot Design: https://penpot.devpanl.dev/workspace/.../file/...
"

# Push branch
git push -u origin feature/DEV-${workItem.id}-auth-flow

# Create PR via GitHub CLI
gh pr create \
  --title "feat(auth): add login form component" \
  --body "Implements DEV-${workItem.id}

## Changes
- Add LoginForm component
- Apply design tokens
- Add unit tests

## Links
- Plane: [DEV-${workItem.id}](https://plane.devpanl.dev/...)
- AFFiNE Spec: [View](https://affine.devpanl.dev/...)
- Penpot Design: [View](https://penpot.devpanl.dev/...)

## Checklist
- [x] Code follows design tokens
- [x] Tests added
- [x] Linter passes
- [ ] Review required
" \
  --base main \
  --head feature/DEV-${workItem.id}-auth-flow
```

---

## Step 8: Update Plane Work Item

```javascript
const prUrl = "https://github.com/OWNER/REPO/pull/123"

await mcp__plane__update_work_item({
  work_item_id: workItemId,
  state: "in_review",
  description: workItem.description + `\n\n**PR**: ${prUrl}`
})
```

---

## Step 9: Enqueue Review Job

```javascript
await bullmq.add('review:pr', {
  pr_number: 123,
  work_item_id: workItemId,
  branch: `feature/DEV-${workItem.id}-auth-flow`
})
```

---

## When to Run

**Trigger conditions**:
- Work item state = "ready-for-dev"
- Work item has design tokens (if UI work)
- Work item has conception doc
- No blocking dependencies

**Concurrency**: Run multiple builder agents in parallel for different work items

---

## Decision Tree

```
build:task job received
  ├─ Read specs from AFFiNE
  ├─ Read design tokens from Penpot (if UI work)
  ├─ Update Plane: state = "in_progress"
  │
  ├─ Implement feature
  │   ├─ Create feature branch
  │   ├─ Write code (follow design tokens)
  │   ├─ Write tests
  │   └─ Run linter
  │
  ├─ Create GitHub PR
  │   ├─ Commit with conventional commit message
  │   ├─ Push branch
  │   └─ gh pr create
  │
  ├─ Update Plane: state = "in_review"
  │   └─ Add PR link to work item
  │
  └─ Enqueue review:pr job for Reviewer agent
```

---

## MCP Tools Used

### AFFiNE
- `read_doc` — Read conception specs, design tokens

### Penpot
- `list_frames` — Get mockup screens
- `get_design_tokens` — Extract CSS variables

### Plane
- `list_work_items` — Get work item details
- `update_work_item` — Update status (in_progress → in_review)

### GitHub
- `gh pr create` (via CLI, not MCP)
- Or use GitHub MCP if available: `create_pull_request`

---

## Code Quality Checks

Before creating PR:
- ✅ Linter passes (`npm run lint`)
- ✅ Tests pass (`npm run test`)
- ✅ Build succeeds (`npm run build`)
- ✅ Design tokens applied correctly
- ✅ Conventional commit message format
- ✅ PR description includes links to Plane/AFFiNE/Penpot

---

## Success Criteria

✅ Feature branch created  
✅ Code implements spec from AFFiNE  
✅ Design matches Penpot mockup  
✅ Tests written and passing  
✅ GitHub PR created with correct metadata  
✅ Plane work item updated to "in_review"  
✅ review:pr job enqueued for Reviewer agent
