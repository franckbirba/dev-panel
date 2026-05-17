# DEVPA-232: devpanel/worker base image.
#
# Ephemeral container spawned by src/worker/container-driver.js for each
# dispatched agent job. The image carries the CLIs (claude, pi, gh, git,
# uvx, node) + the MCP servers (plane-mcp-server via uvx, github-mcp,
# devpanel-mcp via the mounted /workspace).
#
# Build (locally for smoke):
#   docker build -t devpanel/worker:latest -f infra/worker-image/Dockerfile .
#
# Build (on agents host for prod):
#   ssh hetzner-vps 'cd /home/deploy/projects/dev-panel \
#       && docker build -t devpanel/worker:latest -f infra/worker-image/Dockerfile .'
#
# Volumes the driver mounts at runtime:
#   /workspace            ← cwd (the per-job worktree)
#   /etc/devpanel/mcp.json ← worker MCP config (ro)

FROM node:22-bookworm-slim

# System deps: git for worktree ops, gh for PR creation, ca-certs for HTTPS,
# python3 + pipx for uvx (plane-mcp-server is a Python pkg), curl for image
# diagnostics + downloads. Slim image: no compilers, no doc, no recommends.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        python3 \
        python3-pip \
        pipx \
    && rm -rf /var/lib/apt/lists/*

# gh CLI (apt path adds the GH archive keyring)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# uv/uvx for Python MCPs (plane-mcp-server)
RUN pipx install uv && pipx ensurepath
ENV PATH="/root/.local/bin:${PATH}"

# CLIs: claude (Anthropic), pi (DeepInfra harness), qwen (cheap-tier).
# Versions pinned to what the agents host currently runs; bump in sync.
RUN npm install -g --no-audit --no-fund \
        @anthropic-ai/claude-code@latest \
        @earendil-works/pi-coding-agent@0.74.0 \
    && npm cache clean --force

# Prime the uvx cache so first-call latency doesn't blow the first agent's
# tool-discovery budget. plane-mcp-server is the heavy one.
RUN uvx --from plane-mcp-server plane-mcp-server --help > /dev/null 2>&1 || true

WORKDIR /workspace

# stream-json on stdout is the worker's contract — no buffering.
ENV NODE_NO_WARNINGS=1 \
    PYTHONUNBUFFERED=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# The driver overrides CMD with the full claude/pi invocation. Default
# entrypoint is /bin/sh so docker run can pass any CLI we want.
ENTRYPOINT []
CMD ["claude", "--version"]
