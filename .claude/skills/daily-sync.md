---
name: daily-sync
description: Daily synchronization between Plane, GitHub, and DevPanel
---

# Daily Sync Process

Orchestrate data synchronization between DevPanel, Plane, and GitHub systems on a daily basis.

## Overview

The daily sync process ensures that work items, issues, and tickets are properly synchronized across all three platforms:
- **DevPanel**: Internal bug/feature tracking system
- **Plane**: Work item management and project planning
- **GitHub**: Public issue tracking and code management

## Available Commands

### Run Daily Sync
```bash
# Run the daily synchronization process
dev-panel sync --daily
```

This command will:
1. Fetch all projects from DevPanel
2. Synchronize GitHub issues with DevPanel tickets
3. Synchronize Plane work items with GitHub issues
4. Cross-reference statuses between all systems
5. Generate a summary report

## Implementation Details

### Environment Variables Required
- `GITHUB_TOKEN`: GitHub personal access token for API access
- `PLANE_API_KEY` or `PLANE_API_TOKEN`: Plane API key for work item access
- `PLANE_BASE_URL`: Base URL for Plane instance (defaults to https://plane.devpanl.dev)
- `PLANE_WORKSPACE_SLUG`: Plane workspace slug (defaults to 'devpanl')

### Sync Process Flow

1. **Project Discovery**
   - Fetch all projects from DevPanel database
   - For each project, identify associated GitHub repository and Plane project

2. **GitHub Issues Sync**
   - Fetch all issues from GitHub repository (open and closed)
   - Create/update corresponding tickets in DevPanel
   - Sync issue status and metadata

3. **Plane Work Items Sync**
   - Fetch all work items from Plane project
   - Create corresponding GitHub issues where needed
   - Sync work item status and metadata

4. **Cross-Reference Validation**
   - Ensure consistency between systems
   - Identify and report discrepancies
   - Log synchronization results

## Monitoring and Maintenance

### Health Checks
The daily sync process includes built-in health checks for:
- GitHub API connectivity
- Plane API connectivity
- Database access
- File system permissions

### Error Handling
- Failed sync operations are logged with detailed error messages
- Partial failures don't halt the entire process
- Retry mechanisms for transient errors

### Logging
All sync operations are logged with timestamps and status information:
- Number of issues processed
- Number of work items synchronized
- Any errors or warnings encountered
- Performance metrics

## Future Enhancements

### Automated Scheduling
The daily sync can be automated using cron jobs:
```bash
# Run daily sync every day at 2 AM
0 2 * * * /path/to/dev-panel sync --daily >> /var/log/dev-panel-sync.log 2>&1
```

### Bidirectional Sync
Future improvements could include:
- Automatic issue creation in GitHub when work items are created in Plane
- Status updates flowing automatically between all systems
- Enhanced conflict resolution for concurrent updates

### Reporting Dashboard
Planned features include:
- Web-based dashboard for sync status monitoring
- Email notifications for sync failures
- Historical sync performance analytics