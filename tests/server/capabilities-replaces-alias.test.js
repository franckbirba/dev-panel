import { describe, it, expect } from 'vitest';
import { CAPABILITIES, registerCapabilities, REPLACED_RAW_TOOLS } from '../../src/capabilities/index.js';

// Capabilities declare `replaces: [oldName, ...]` to document the raw
// tools they subsume. registerCapabilities() must wire each of those
// names as an alias delegating to the same handler — Qwen3 and other
// models frequently hallucinate the older names from training-data
// familiarity, and we'd rather serve them than 404 with "Load failed".

function makeFakeServer() {
  const tools = new Map();
  return {
    tools,
    tool(name, description, shape, handler) {
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
});
