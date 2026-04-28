// MCP server profile filter.
//
// dev-panel ships a single MCP server (`src/mcp/server.js`) with a wide tool
// surface — orchestration, dispatch, page write, memory write, etc. The
// internal Shelly process needs all of it. The PUBLIC Shelly process (widget
// chat for end-users of DevPanel-instrumented apps) must NEVER be able to
// dispatch jobs, write Plane pages, write memory, or otherwise reach beyond
// FAQ + capture-create.
//
// Cycle "Shelly in the Widget" (DEVPA-159) settled this with a build flag:
// the same server code, but at startup `MCP_PROFILE=public` causes
// non-whitelisted tools to never get registered. The tools simply do not
// exist in the running process — there is no runtime ACL to bypass, no
// Claude prompt to jailbreak. If the upstream wants to add a new write tool,
// they must extend the whitelist explicitly.
//
// The whitelist matches DEVPA-159 / memory 88331d34:
//   - plane_list_pages, plane_get_page, plane_get_page_html  (FAQ source)
//   - list_work_items, retrieve_work_item                     (read-only Plane)
//   - thread_append                                           (route widget
//                                                              replies into
//                                                              dashboard
//                                                              threads)
//   - capture_create                                          (file a bug or
//                                                              feature)
//
// Future widget-bridge tool (`widget_reply`, see DEVPA-163) will be added
// here when it lands.

export const PUBLIC_TOOL_WHITELIST = new Set([
  'plane_list_pages',
  'plane_get_page',
  'plane_get_page_html',
  'list_work_items',
  'retrieve_work_item',
  'thread_append',
  'capture_create'
]);

export function getProfile() {
  return process.env.MCP_PROFILE || 'internal';
}

// Return true iff the named tool may be exposed under the given profile.
// `internal` profile is the legacy full surface — every tool is allowed.
// `public` profile is the FAQ-safe whitelist above; everything else is
// dropped at registration time.
export function isToolAllowed(name, profile = getProfile()) {
  if (profile !== 'public') return true;
  return PUBLIC_TOOL_WHITELIST.has(name);
}

// Wrap an McpServer-like object so calls to `.tool(name, ...)` are filtered
// by the active profile. Returns the same server, mutated in place. Adds
// `getRegisteredToolNames()` so callers (notably tests) can introspect the
// surface that was actually exposed.
//
// We intentionally do NOT log filtered registrations. The point of a
// build-flag deny list is that the dropped tool is invisible — surfacing
// "this tool was suppressed" in stderr would let an operator wonder whether
// the tool can be re-enabled, which is the wrong mental model.
export function wrapServerWithProfile(server, profile = getProfile()) {
  const registered = [];
  const original = server.tool.bind(server);
  server.tool = function tool(name, ...rest) {
    if (!isToolAllowed(name, profile)) return undefined;
    registered.push(name);
    return original(name, ...rest);
  };
  server.getRegisteredToolNames = () => [...registered];
  server.getProfile = () => profile;
  return server;
}
