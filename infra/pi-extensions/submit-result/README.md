# `submit_result` — structured job-closing envelope for Pi

Single-tool Pi extension that replaces "print the envelope JSON on your last
line" with a real tool call. See [the docstring in `index.ts`](./index.ts)
for the full rationale (H3, `docs/architecture/harness-pi.md` §4.1).

## Tool

- `submit_result({ status, summary, artifacts, handoff, memory_writes_count, blockers, issues_found })`
  → writes the envelope to `.pi-submit-result.json` in the agent's cwd and
  returns `{ ok: true, envelope }`.

The parameter schema is the envelope v1 contract from
`src/worker/prompt-builder.js` (`REQUIRED_TOP` + the JSON template shown in
every role's SOUL prompt), copied field-for-field.

## Why a tool call instead of trailing JSON

`pi-driver.js`'s `parseResult(lastAssistantText)` path — "the envelope is
the last JSON-looking line of the final message" — works for Claude but
fails on Qwen3-Coder-480B roughly 70% of the time on long runs (see the
comment block above `synthesizePiResult` in `pi-driver.js`): trailing prose
with no JSON, a hallucinated `<tool_call>` XML fragment, or the object cut
mid-stream by a per-message token cap. Tool-call argument generation is a
better-trained behavior for weak coder models than closing-format
compliance in free text — the same insight mini-swe-agent and SWE-agent
both build their "submit" step around.

## Read order in `pi-driver.js`

1. `.pi-submit-result.json` sentinel file in `cwd`, if present and it parses
   as valid JSON matching the envelope shape (`prompt-builder.js#validate`).
2. `parseResult(lastAssistantText)` — legacy path, still tried in case a
   model (or Claude, if ever routed through pi) closes with the JSON
   directly instead of calling the tool.
3. `synthesizePiResult` — introspects `git status`/`git log` as a last
   resort when neither of the above produced anything usable.

## Loop-guard integration

`submit_result`'s own `tool_call` listener sets a flag; the extension's
`turn_end` handler requests `ctx.shutdown()` once that flag is set — the
same termination mechanism `loop-guard`'s closing-marker path uses. This
means completion no longer depends on the model ALSO echoing a marker
string in a later assistant turn: calling `submit_result` alone is enough
to end the run cleanly.

## Loading

```
pi --extension <repo>/infra/pi-extensions/submit-result
```

Already wired into `DEFAULT_PI_EXTENSIONS` in `src/worker/pi-driver.js` and
`PI_EXTENSION_NAMES` in `src/worker/container-driver.js`.

## Tunables (env vars)

- `PI_SUBMIT_RESULT_FILENAME` — sentinel filename, relative to cwd unless
  absolute (default `.pi-submit-result.json`).
- `PI_LOOP_CLOSING_MARKER` — shared with `loop-guard`; only affects the
  cosmetic marker string included in the tool result text, not the
  shutdown mechanism (which is tool-call-driven, not text-driven).

## Related

- `infra/pi-extensions/loop-guard/` — repetition guard + the closing-marker
  shutdown mechanism this extension reuses.
- `infra/pi-extensions/create-file/` — sibling extension this one mirrors
  the file layout and no-extra-dependency pattern of (both use only
  `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent`, already
  present via pi's own install — no `dependencies` block needed).
