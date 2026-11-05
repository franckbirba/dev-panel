# 0001 - Docker Compose Requirement for Demo Applications

## Status
Accepted

## Context
The DevPanel architecture requires that all demo applications must include a docker-compose setup with both frontend and backend services. This ensures:

1. Consistent deployment across environments
2. Isolated worktrees with non-conflicting port allocations
3. Health checking capabilities
4. Preview URLs for easy validation

Each worktree should contain a docker-compose.yml file that defines the application services along with example environment variables (without hardcoded secrets).

## Decision
We mandate that all architect agent outputs must include a docker-compose.yml file defining both frontend and backend services. The validation process will reject any result that doesn't meet this requirement.

The docker-compose setup must:
- Define services for both frontend and backend components
- Use environment variables for configuration (no hardcoded secrets)
- Implement health checks for all services
- Allocate ports dynamically to prevent conflicts between worktrees
- Provide a preview URL accessible from the host system

## Consequences
- All demo applications will have a consistent deployment mechanism
- Developers can easily run and test applications locally
- Preview URLs will be automatically generated and reported
- Port conflicts between concurrent worktrees will be eliminated
- Health status of services will be monitorable

This decision aligns with the broader DevPanel architecture which emphasizes containerization and consistent deployment practices.