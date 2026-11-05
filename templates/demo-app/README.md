# Demo Application Template

This template provides a starting point for demo applications that need to be deployed with Docker Compose.

## Structure

- `docker-compose.yml`: Defines the services (frontend, backend, database, redis)
- `.env.example`: Example environment variables
- `Dockerfile.frontend`: Template for frontend service
- `Dockerfile.backend`: Template for backend service

## Usage

1. Copy this directory to your worktree
2. Customize the Dockerfiles for your specific frontend/backend technologies
3. Adjust the docker-compose.yml as needed for your services
4. Copy `.env.example` to `.env` and adjust values
5. Run `docker-compose up` to start the services

## Environment Variables

The template uses the following environment variables:

- `PORT_FRONTEND`: Port for the frontend service (default: 3000)
- `PORT_BACKEND`: Port for the backend service (default: 8000)

These can be overridden by setting them in your environment or .env file.

## Health Checks

All services include health checks that verify the services are running correctly:

- Frontend: HTTP GET to `/health` endpoint
- Backend: HTTP GET to `/health` endpoint
- Database: PostgreSQL readiness check
- Redis: Redis ping command

## Preview URL

After starting the services, the preview will be available at:

- Frontend: http://localhost:${PORT_FRONTEND}
- Backend: http://localhost:${PORT_BACKEND}

The exact URL will be reported by the builder agent when it starts the services.