import { describe, it, expect } from 'vitest';
import { CAPABILITIES, registerCapabilities, REPLACED_RAW_TOOLS } from '../../src/capabilities/index.js';

// Capabilities declare `replaces: [oldName, ...]` to document the raw
// tools they subsume. registerCapabilities() must wire each of those
// names as an alias delegating to the same handler — Qwen3 and other
// models frequently hallucinate the older names from training-data
// familiarity, and we'd rather serve them than 404 with "Load failed".

function makeFakeServer() {
  const tools = new Map();
  // Mirror the @modelcontextprotocol/sdk McpServer surface: a real
  // McpServer throws "Tool <name> is already registered" on duplicate
  // calls and exposes `_registeredTools` for membership checks. The
  // alias loop in registerCapabilities relies on `_registeredTools`
  // to stay idempotent when a raw tool of the same name is already
  // declared elsewhere on the server (e.g. `list_captures`).
  const _registeredTools = Object.create(null);
  return {
    tools,
    _registeredTools,
    tool(name, description, shape, handler) {
      if (_registeredTools[name]) {
        throw new Error(`Tool ${name} is already registered`);
      }
      _registeredTools[name] = true;
      tools.set(name, { name, description, shape, handler });
    },
  };
}

describe('registerCapabilities()', () => {
  it('registers each canonical capability name', () => {
    const server = makeFakeServer();
    registerCapabilities(server);
    for (const cap of CAPABILITIES) {
      expect(server.tools.has(cap.name), `canonical ${cap.name} missing`).toBe(true);
    }
  });

  it('registers an alias for every name in `replaces`', () => {
    const server = makeFakeServer();
    registerCapabilities(server);
    const expectedAliases = CAPABILITIES.flatMap((c) =>
      (c.replaces ?? []).filter((alias) => alias !== c.name)
    );
    expect(expectedAliases.length).toBeGreaterThan(0);
    for (const alias of expectedAliases) {
      expect(server.tools.has(alias), `alias ${alias} missing`).toBe(true);
    }
  });

  it('alias for host_status covers the legacy `ssh_status` name', () => {
    const server = makeFakeServer();
    registerCapabilities(server);
    expect(server.tools.has('ssh_status')).toBe(true);
    expect(server.tools.get('ssh_status').description).toMatch(/alias of host_status/);
  });

  it('alias for tail_log_snapshot covers the legacy `tail_log` name', () => {
    const server = makeFakeServer();
    registerCapabilities(server);
    expect(server.tools.has('tail_log')).toBe(true);
  });

  it('REPLACED_RAW_TOOLS lists all aliases', () => {
    const replacedSet = new Set(REPLACED_RAW_TOOLS);
    expect(replacedSet.has('ssh_status')).toBe(true);
    expect(replacedSet.has('tail_log')).toBe(true);
  });

  it('skips an alias when a tool of the same name is already registered', () => {
    // Reproduces the prod outage 2026-05-11 where `list_captures` was
    // declared as a raw tool in `src/mcp/server.js` AND listed in
    // `triageInbox.replaces`. registerCapabilities() must NOT re-register
    // — that throws "Tool <name> is already registered" and tears down the
    // entire MCP HTTP mount, leaving streamText with zero tools and Qwen3
    // narrating tool names in prose.
    const server = makeFakeServer();
    // Pre-register `list_captures` to simulate src/mcp/server.js's direct
    // server.tool() call which runs before registerCapabilities().
    server.tool('list_captures', 'pre-existing raw tool', {}, () => null);
    expect(() => registerCapabilities(server)).not.toThrow();
    // Pre-existing handler must be preserved — the alias loop must NOT
    // overwrite it.
    expect(server.tools.get('list_captures').description).toBe('pre-existing raw tool');
    // Every canonical capability still registered.
    for (const cap of CAPABILITIES) {
      expect(server.tools.has(cap.name)).toBe(true);
    }
  });
});
