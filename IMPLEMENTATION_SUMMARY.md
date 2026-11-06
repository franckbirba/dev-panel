# Implementation Summaries

## Node/Hub Protocol with Revocable Tokens and Secret Isolation

### Authentication and enrollment

- External nodes authenticate with individual random tokens stored as SHA-256 hashes.
- Admin routes enroll and revoke nodes, and issue repository/branch/time-scoped task tokens.
- The legacy shared token remains limited to the internal worker.
- Socket.IO connections are bound to the authenticated `node_id`.

### Task token lifecycle

- Claims use atomic database updates and reject expired, revoked, completed, or already claimed tokens.
- Heartbeats are restricted to the claiming node and extend the lease without shortening it.
- Results are restricted to the claiming node and completion is idempotent.
- Raw node and task tokens are never stored or logged.

### Container isolation

- External containers do not mount the centralized MCP configuration or use the host network.
- Central Redis, Postgres, Plane, GitHub, and AI credentials are not passed to external containers.
- Only the task token and explicitly node-provided AI configuration are allowed.

### Verification

- Agent node and task token lifecycle tests.
- Socket.IO authentication, claim, heartbeat, result, and ownership tests.
- Admin enrollment and task token issuance tests.
- Container environment isolation tests.

## SOUL Agents for the Démo Assinie Workflow

### Roles

- `.agents/full-stack/` implements frontend and backend features.
- `.agents/ops/` verifies Docker Compose, builds, health checks, and operational readiness.
- `.agents/cybersecurity/` audits secrets and the configuration attack surface.

### Workflow and tests

- `src/worker/workflows/assinie-demo.yaml` integrates the new roles with explicit transitions and bounded retreats.
- Tests cover SOUL loading, workflow loading, successful transitions, security/ops rejection, and builder retreats.
- The existing builder → reviewer → QA workflow remains available.
- Pull requests may auto-merge only after required checks pass; no signature gate is imposed by this implementation.
