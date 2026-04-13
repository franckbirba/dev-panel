---
name: agent-qa
description: QA Agent - Automated E2E testing with Playwright, smoke tests, visual regression
---

# QA Agent — Automated Testing & Quality Assurance

**Trigger**: `qa:run` BullMQ job (after PR merge or on-demand)

**MCP Access**: Playwright, DevPanel API, Plane, GitHub

**Responsibilities**:
1. Run E2E tests in headless browser (Playwright)
2. Smoke tests for critical user flows
3. Visual regression testing (screenshot comparison)
4. Report test results to Plane work item
5. Create bug tickets in DevPanel if tests fail
6. Update GitHub PR with test status

---

## Step 1: Initialize Playwright Browser

```javascript
// Navigate to deployed app
mcp__playwright__browser_navigate({
  url: "https://devpanl.dev"
})

// Resize for desktop testing
mcp__playwright__browser_resize({
  width: 1920,
  height: 1080
})
```

---

## Step 2: Run Smoke Tests

### Critical User Flows

**1. DevPanel Widget - Bug Report Flow**

```javascript
// 1. Take initial screenshot
mcp__playwright__browser_take_screenshot({
  filename: "smoke-test-initial.png",
  type: "png"
})

// 2. Click DevPanel widget button
mcp__playwright__browser_click({
  ref: "[aria-label='Report Bug']",
  element: "DevPanel floating button"
})

// 3. Fill bug report form
mcp__playwright__browser_type({
  ref: "input[name='title']",
  text: "Test bug report from QA agent",
  element: "Bug title input"
})

mcp__playwright__browser_type({
  ref: "textarea[name='description']",
  text: "Automated test - verifying bug report submission flow",
  element: "Bug description textarea"
})

// 4. Take screenshot
mcp__playwright__browser_take_screenshot({
  filename: "smoke-test-form-filled.png"
})

// 5. Submit form
mcp__playwright__browser_click({
  ref: "button[type='submit']",
  element: "Submit bug report button"
})

// 6. Wait for success message
mcp__playwright__browser_wait_for({
  text: "Bug report submitted successfully"
})

// 7. Final screenshot
mcp__playwright__browser_take_screenshot({
  filename: "smoke-test-success.png"
})
```

**2. API Health Check**

```javascript
// Check API endpoint
mcp__playwright__browser_navigate({
  url: "https://devpanl.dev/api/health"
})

// Verify response
mcp__playwright__browser_snapshot({
  filename: "api-health-check.md"
})
```

---

## Step 3: E2E Test Scenarios

### Scenario 1: Complete Bug Report Workflow

```javascript
// 1. Navigate to test app
mcp__playwright__browser_navigate({
  url: "https://devpanl.dev"
})

// 2. Open DevPanel widget
mcp__playwright__browser_click({
  ref: ".devpanel-widget-trigger",
  element: "DevPanel trigger button"
})

// 3. Select "Bug Report"
mcp__playwright__browser_click({
  ref: "button[data-type='bug']",
  element: "Bug report type button"
})

// 4. Fill form with test data
const bugTitle = `E2E Test Bug - ${Date.now()}`
mcp__playwright__browser_fill_form({
  fields: [
    {
      name: "title",
      ref: "input[name='title']",
      type: "textbox",
      value: bugTitle
    },
    {
      name: "description",
      ref: "textarea[name='description']",
      type: "textbox",
      value: "This is an automated E2E test from QA agent"
    },
    {
      name: "priority",
      ref: "select[name='priority']",
      type: "combobox",
      value: "medium"
    }
  ]
})

// 5. Upload screenshot (optional)
// Note: File upload requires local file path
// mcp__playwright__browser_file_upload({ paths: ["./test-screenshot.png"] })

// 6. Submit
mcp__playwright__browser_click({
  ref: "button[type='submit']",
  element: "Submit form button"
})

// 7. Verify success
mcp__playwright__browser_wait_for({
  text: "Thank you for your report"
})

// 8. Take final screenshot for verification
mcp__playwright__browser_take_screenshot({
  filename: `e2e-bug-report-${Date.now()}.png`
})
```

---

## Step 4: Visual Regression Testing

```javascript
// Take baseline screenshots of key pages
const pages = [
  { url: "https://devpanl.dev", name: "homepage" },
  { url: "https://plane.devpanl.dev", name: "plane-dashboard" },
  { url: "https://affine.devpanl.dev", name: "affine-workspace" },
  { url: "https://penpot.devpanl.dev", name: "penpot-projects" }
]

for (const page of pages) {
  mcp__playwright__browser_navigate({ url: page.url })
  mcp__playwright__browser_wait_for({ time: 2 }) // Wait for full load
  mcp__playwright__browser_take_screenshot({
    filename: `visual-${page.name}-${Date.now()}.png`,
    fullPage: true
  })
}
```

**Compare with baseline** (manual for now, can be automated with image diff tools)

---

## Step 5: Report Test Results to Plane

```javascript
// Get Plane work item from BullMQ job data
const workItemId = job.data.work_item_id

// Update work item with test results
mcp__plane__update_work_item({
  work_item_id: workItemId,
  state: testsPassed ? "done" : "in_progress",
  labels: testsPassed ? ["qa-passed"] : ["qa-failed", "needs-fix"]
})

// Add comment with test report
const testReport = `
## QA Test Results

**Status**: ${testsPassed ? "✅ PASSED" : "❌ FAILED"}
**Date**: ${new Date().toISOString()}

### Smoke Tests
- Bug Report Flow: ${smokeTests.bugReport ? "✅" : "❌"}
- API Health Check: ${smokeTests.apiHealth ? "✅" : "❌"}

### E2E Tests
- Complete Bug Workflow: ${e2eTests.bugWorkflow ? "✅" : "❌"}

### Visual Regression
- Screenshots captured: ${visualTests.screenshots.length}
- Baseline comparison: Manual review required

**Test artifacts**: [View screenshots](https://devpanl.dev/qa/reports/${testRunId})
`

// Add comment via Plane API (using mcp__plane__ tools)
// Note: Plane MCP may not have direct comment API, use GitHub PR comments instead
```

---

## Step 6: Create DevPanel Tickets for Failures

If tests fail, create bug tickets:

```javascript
// Use DevPanel MCP server
mcp__dev_panel__create_ticket({
  type: "bug",
  title: `QA Failure: ${failedTest.name}`,
  description: `
Automated test failed during QA run.

**Test**: ${failedTest.name}
**Expected**: ${failedTest.expected}
**Actual**: ${failedTest.actual}
**Screenshot**: [View](${failedTest.screenshot})
**Work Item**: ${workItemId}
  `,
  priority: "high",
  source: "qa-automation"
})
```

---

## Step 7: Update GitHub PR Status

```javascript
// Post test results as PR comment
// (Requires GitHub MCP or direct API call)

const prComment = `
## 🤖 QA Test Results

${testsPassed ? "✅ All tests passed" : "❌ Tests failed"}

<details>
<summary>Test Summary</summary>

${testReport}

</details>
`

// Note: Use GitHub MCP when available, or direct API call
```

---

## Test Suites

### 1. Smoke Tests (Fast, <2 min)
- API health check
- Homepage loads
- DevPanel widget renders
- Form submission works

### 2. E2E Tests (Medium, 5-10 min)
- Complete bug report workflow
- Feature request workflow
- Admin API key validation
- Screenshot upload
- Multi-project isolation

### 3. Visual Regression (Slow, 10-15 min)
- Homepage screenshot
- DevPanel widget states (closed, open, form filled)
- Success/error states
- Mobile responsive views

---

## When to Run

**Automatic triggers**:
- On PR merge to main (smoke + E2E)
- Nightly cron (full suite + visual regression)
- On-demand via Telegram command `/qa run`

**Manual triggers**:
- Before production deployment
- After infrastructure changes
- When validating bug fixes

---

## Playwright MCP Tools Used

- `browser_navigate` — Load pages
- `browser_click` — Interact with elements
- `browser_type` — Fill text inputs
- `browser_fill_form` — Fill entire forms
- `browser_take_screenshot` — Capture visuals
- `browser_snapshot` — Get accessibility tree (better for assertions)
- `browser_wait_for` — Wait for text/elements
- `browser_resize` — Test responsive layouts
- `browser_tabs` — Test multi-tab scenarios

---

## Success Criteria

✅ All smoke tests pass in <2 minutes
✅ E2E tests validate complete user flows
✅ Visual regression screenshots captured
✅ Test results reported to Plane work items
✅ Failed tests create DevPanel bug tickets
✅ GitHub PRs updated with test status
✅ Playwright runs in headless mode (no GUI required)

---

## Failure Handling

If tests fail:
1. Take error screenshot
2. Capture browser console logs (`browser_console_messages`)
3. Capture network requests (`browser_network_requests`)
4. Create DevPanel bug ticket with full context
5. Notify PM agent via BullMQ (`qa:failed` job)
6. Block deployment if critical tests fail

---

## Example: Full QA Run

```javascript
async function runQASuite(job) {
  const { work_item_id, pr_number } = job.data

  // 1. Initialize
  mcp__playwright__browser_navigate({ url: "https://devpanl.dev" })

  // 2. Run smoke tests
  const smokeResults = await runSmokeTests()

  // 3. Run E2E tests
  const e2eResults = await runE2ETests()

  // 4. Visual regression
  const visualResults = await runVisualTests()

  // 5. Generate report
  const allPassed = [smokeResults, e2eResults, visualResults].every(r => r.passed)

  // 6. Update Plane
  mcp__plane__update_work_item({
    work_item_id,
    state: allPassed ? "done" : "in_progress",
    labels: allPassed ? ["qa-passed"] : ["qa-failed"]
  })

  // 7. Create bug tickets for failures
  if (!allPassed) {
    for (const failure of getFailures([smokeResults, e2eResults])) {
      mcp__dev_panel__create_ticket({
        type: "bug",
        title: `QA: ${failure.name}`,
        description: failure.details,
        priority: "high"
      })
    }
  }

  return { success: allPassed, results: { smokeResults, e2eResults, visualResults } }
}
```
