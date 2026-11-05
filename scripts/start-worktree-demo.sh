#!/bin/bash

# Script to start a demo application in a worktree using docker-compose
# Usage: ./scripts/start-worktree-demo.sh [project-name]

set -e

PROJECT_NAME=${1:-$(basename $(pwd))}
COMPOSE_PROJECT_NAME="devpanel-${PROJECT_NAME}"

echo "Starting demo application: ${PROJECT_NAME}"
echo "Docker Compose project name: ${COMPOSE_PROJECT_NAME}"

# Check if docker-compose.yml exists
if [ ! -f "docker-compose.yml" ]; then
  echo "Error: docker-compose.yml not found in current directory"
  exit 1
fi

# Create .env file from example if it doesn't exist
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  echo "Creating .env from .env.example"
  cp .env.example .env
fi

# Start the services
echo "Starting services..."
docker-compose -p "${COMPOSE_PROJECT_NAME}" up -d

# Wait for services to be healthy
echo "Waiting for services to be healthy..."
sleep 10

# Show the status
echo ""
echo "Service status:"
docker-compose -p "${COMPOSE_PROJECT_NAME}" ps

# Show the preview URL
FRONTEND_PORT=$(docker-compose -p "${COMPOSE_PROJECT_NAME}" port frontend 3000 | cut -d: -f2)
BACKEND_PORT=$(docker-compose -p "${COMPOSE_PROJECT_NAME}" port backend 8000 | cut -d: -f2)

echo ""
echo "Preview URLs:"
echo "  Frontend: http://localhost:${FRONTEND_PORT:-3000}"
echo "  Backend: http://localhost:${BACKEND_PORT:-8000}"

echo ""
echo "To stop the services, run: docker-compose -p \"${COMPOSE_PROJECT_NAME}\" down"