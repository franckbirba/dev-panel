# ============================================================================
# DEVPANEL — Production Dockerfile
# ============================================================================

FROM node:22-alpine AS base

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY . .

# Runtime stage
FROM node:22-alpine

WORKDIR /app

# Copy from base stage
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package*.json ./
COPY --from=base /app/bin ./bin
COPY --from=base /app/src ./src
COPY --from=base /app/templates ./templates
COPY --from=base /app/claw.js ./claw.js

# dist/ is mounted as volume in docker-compose (../dist:/app/dist)
# Do NOT COPY it here — .dockerignore excludes it

# Create storage directory
RUN mkdir -p /app/storage && chown -R node:node /app/storage

# Use non-root user
USER node

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3030/api/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

EXPOSE 3030

CMD ["node", "bin/dev-panel.js", "serve", "--host", "0.0.0.0"]
