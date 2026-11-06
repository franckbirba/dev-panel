# Docker Compose Requirement for Demo Applications

## Overview

As of November 2026, all demo applications created by the DevPanel system must include a docker-compose setup with both frontend and backend services. This requirement ensures consistency, portability, and ease of deployment across different environments.

## Requirements

### Mandatory Components

1. **docker-compose.yml**: Must define at least frontend and backend services
2. **Dockerfiles**: Separate Dockerfiles for frontend and backend components
3. **Environment Variables**: Use of `.env` files for configuration (example in `.env.example`)
4. **Health Checks**: All services must include health check definitions
5. **Port Management**: Dynamic port allocation to prevent conflicts between worktrees

### Template Location

Templates for these components are available in:
```
templates/demo-app/
```

This directory contains:
- `docker-compose.yml` - Base composition file
- `.env.example` - Example environment variables
- `README.md` - Usage instructions
- `Dockerfile.frontend` - Template for frontend service
- `Dockerfile.backend` - Template for backend service

## Implementation

### For Architect Agent

The architect agent must:
1. Reference the templates in `templates/demo-app/` for consistent structure
2. Ensure all generated ADRs require docker-compose setups
3. Never hardcode ports or environment-specific values

### For Builder Agent

The builder agent must:
1. Include docker-compose.yml with front+back services in worktree for demo applications
2. Use environment variables for configuration
3. Implement health checks for all services
4. Report preview URLs in the result

## Validation

The system validates architect results to ensure they include docker-compose files. The validation is implemented in `src/worker/prompt-builder.js` and checks that artifacts include files with "docker-compose" or "Dockerfile" in their names.

## Benefits

1. **Consistency**: All demo applications follow the same deployment pattern
2. **Isolation**: Worktrees can run simultaneously without port conflicts
3. **Portability**: Easy to deploy in different environments
4. **Monitoring**: Health checks enable service monitoring
5. **Documentation**: Standard structure makes it easier for developers to understand