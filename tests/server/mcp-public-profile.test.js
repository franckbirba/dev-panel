// Tests for the MCP_PROFILE=public build flag.
//
// DEVPA-159 (Shelly publique) decided that the FAQ-safe MCP surface is
// guarded by a build flag — the same `src/mcp/server.js` is used for both
// internal and public Shelly, but at startup `MCP_PROFILE=public` causes
// non-whitelisted tools to never get registered. There is no runtime ACL
// to bypass; the tool simply does not exist in the running process.
//
// These tests pin both halves of that contract:
//   1. profile.js gating — pure logic, easy to assert.
//   2. server.js end-to-end — boot the actual server in public mode and
//      check the registered tool surface against the whitelist + blocklist
//      from the work-item acceptance criteria.

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  PUBLIC_TOOL_WHITELIST,
  isToolAllowed,
  wrapServerWithProfile
} from '../../src/mcp/profile.js';

describe('MCP profile filter — pure logic', () => {
  it('exposes the FAQ-safe whitelist exactly matching DEVPA-159', () => {
    // If this list shifts, update the SOUL + the agents-mcp-public.json
    // template in the same change. Drift here means production Shelly
    // publique gets new powers without anyone reviewing the SOUL.
    expect([...PUBLIC_TOOL_WHITELIST].sort()).toEqual([
      'capture_create',
      'list_work_items',
      'plane_get_page',
      'plane_get_page_html',
      'plane_list_pages',
      'retrieve_work_item',
      'thread_append'
    ]);
  });

  it('isToolAllowed returns true for everything in internal profile', () => {
    expect(isToolAllowed('plane_create_page', 'internal')).toBe(true);
    expect(isToolAllowed('memory_write', 'internal')).toBe(true);
    expect(isToolAllowed('enqueue_job', 'internal')).toBe(true);
    expect(isToolAllowed('totally_made_up_tool', 'internal')).toBe(true);
  });

  it('isToolAllowed returns true only for whitelisted tools in public profile', () => {
    for (const t of [
      'plane_list_pages',
      'plane_get_page',
      'plane_get_page_html',
      'list_work_items',
      'retrieve_work_item',
      'thread_append',
      'capture_create'
    ]) {
      expect(isToolAllowed(t, 'public')).toBe(true);
    }
  });

  it('isToolAllowed blocks every dangerous tool from the acceptance criteria', () => {
    const blocked = [
      'plane_create_page',
      'plane_update_page',
      'plane_update_page_content',
      'plane_archive_page',
      'plane_delete_page',
      'plane_dispatch_work_item',
      'enqueue_job',
      'devpanel_workflow_dispatch',
      'cancel_job',
      'memory_write'
    ];
    for (const t of blocked) {
      expect(isToolAllowed(t, 'public')).toBe(false);
    }
  });
});

describe('wrapServerWithProfile — registration filter', () => {
  it('registers every tool in internal profile', () => {
    const recorded = [];
    const fakeServer = { tool: (name) => recorded.push(name) };
    const wrapped = wrapServerWithProfile(fakeServer, 'internal');
    wrapped.tool('plane_create_page');
    wrapped.tool('plane_list_pages');
    wrapped.tool('memory_write');
    expect(recorded).toEqual(['plane_create_page', 'plane_list_pages', 'memory_write']);
    expect(wrapped.getRegisteredToolNames()).toEqual(['plane_create_page', 'plane_list_pages', 'memory_write']);
  });

  it('drops non-whitelisted registrations in public profile without throwing', () => {
    const recorded = [];
    const fakeServer = { tool: (name) => recorded.push(name) };
    const wrapped = wrapServerWithProfile(fakeServer, 'public');
    wrapped.tool('plane_create_page');     // dropped
    wrapped.tool('plane_list_pages');      // kept
    wrapped.tool('memory_write');          // dropped
    wrapped.tool('capture_create');        // kept
    wrapped.tool('plane_dispatch_work_item'); // dropped
    expect(recorded).toEqual(['plane_list_pages', 'capture_create']);
    expect(wrapped.getRegisteredToolNames()).toEqual(['plane_list_pages', 'capture_create']);
  });

  it('forwards extra arguments (description / schema / handler) to the underlying tool()', () => {
    const calls = [];
    const fakeServer = { tool: (...args) => calls.push(args) };
    const wrapped = wrapServerWithProfile(fakeServer, 'internal');
    const handler = async () => ({});
    wrapped.tool('plane_list_pages', 'desc', { project: 'string' }, handler);
    expect(calls).toEqual([['plane_list_pages', 'desc', { project: 'string' }, handler]]);
  });
});

describe('src/mcp/server.js boot in MCP_PROFILE=public', () => {
  it('registers exactly the FAQ-safe surface and none of the dangerous tools', async () => {
    // Boot the actual server.js with the public profile and the autostart
    // guard, so we can introspect the registry without binding stdio. This
    // is the closest thing to "what will Shelly publique actually see at
    // runtime" we can assert from a unit test.
    process.env.MCP_PROFILE = 'public';
    process.env.MCP_NO_AUTOSTART = '1';
    process.env.DEVPANEL_STORAGE = mkdtempSync(join(tmpdir(), 'mcp-pub-'));
    // Avoid the boot smoke test inside server.js trying to hit Plane.
    delete process.env.PLANE_SHELLY_EMAIL;

    const mod = await import('../../src/mcp/server.js');
    const names = mod.getRegisteredToolNames();

    // Whitelist — every entry from the acceptance criteria must be present.
    for (const t of [
      'plane_list_pages',
      'plane_get_page',
      'plane_get_page_html',
      'list_work_items',
      'retrieve_work_item',
      'thread_append',
      'capture_create'
    ]) {
      expect(names, `expected ${t} to be registered in public profile`).toContain(t);
    }

    // Blocklist — every dangerous tool from the acceptance criteria must be
    // absent. Any of these slipping back into the registry is a security
    // regression.
    const blocked = [
      'plane_create_page',
      'plane_update_page',
      'plane_update_page_content',
      'plane_archive_page',
      'plane_delete_page',
      'plane_dispatch_work_item',
      'enqueue_job',
      'devpanel_workflow_dispatch',
      'cancel_job',
      'memory_write'
    ];
    for (const t of blocked) {
      expect(names, `expected ${t} to be ABSENT in public profile`).not.toContain(t);
    }
  });
});
