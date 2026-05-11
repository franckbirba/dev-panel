// Stub for src/packages/chat-renderer/parser.js
//
// The synced apps/chat/lib/chat-renderer-types.ts imports the real parser
// via a relative path "../../../src/packages/chat-renderer/parser.js" that
// resolves correctly in the dev-panel repo but breaks once the file is
// shipped to the storybook catalogue volume (where the relative jump lands
// outside /_src/). Stories only consume the *types* from chat-renderer-types,
// not these runtime helpers — so a no-op stub keeps the module graph happy
// without dragging the real chat-renderer package into the catalogue image.
//
// If a future story needs to exercise the real parser, ship the package
// into the catalogue properly (via a second sync source) and remove this
// alias.

export const RENDERER_PAYLOAD_TYPES = [];

export function parseRendererPayload() {
  return null;
}

export function extractRendererPayload() {
  return null;
}
