# Merge Coordinator High-Risk Labels

## Overview

The merge-coordinator workflow implements automated merging for agent-generated PRs. However, certain work domains require human review before merging for security and compliance reasons.

## High-Risk Domains

The following domains are considered high-risk and require human approval:

- **Migration** - Database schema changes, data migrations
- **Auth** - Authentication and authorization systems
- **Payment** - Financial transactions and billing systems
- **Schema** - Core data structure modifications

## Implementation

### Label-Based Blocking

Work items tagged with high-risk labels in Plane will automatically be blocked from auto-merge:

- `high-risk` - Generic high-risk flag
- `migration` - Migration-related work items
- `auth` - Authentication/authorization work items
- `payment` - Payment/billing work items
- `schema` - Schema/data structure work items

### Workflow Behavior

When a high-risk item is detected:

1. PR is created normally by the work-item workflow
2. merge-coordinator workflow detects the high-risk label
3. Auto-merge is blocked
4. Workflow instance status set to `awaiting_approval`
5. Notification sent to Shelly channel for manual review

### Project Configuration

#### DEVPA Project

- Label ID: `high-risk` (color: red)
- Label ID: `migration` (color: orange)
- Label ID: `auth` (color: purple)
- Label ID: `payment` (color: blue)
- Label ID: `schema` (color: green)

#### Zeno Project

- Label ID: `high-risk` (color: red)
- Label ID: `migration` (color: orange)
- Label ID: `auth` (color: purple)
- Label ID: `payment` (color: blue)
- Label ID: `schema` (color: green)

## Manual Approval Process

1. Team lead reviews the PR in GitHub
2. Validates the implementation meets security requirements
3. Removes the high-risk label if appropriate
4. Merges the PR manually
5. Updates Plane work item status to Done

## Testing

Ensure tests cover:

- Label propagation from backlog puller to merge-coordinator
- High-risk label detection and blocking
- Status update to `awaiting_approval`
- Notification sending
- Normal workflow for non-high-risk items