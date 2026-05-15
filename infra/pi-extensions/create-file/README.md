# `create-file` — safe new-file tool for Pi

Single-tool Pi extension that replaces Pi's built-in `write` when running
weak coder models (Qwen3-Coder, DeepSeek-V3, Llama-3.3-70B). The built-in
`write` lets the model serialize an entire multi-construct source file into
one string parameter, which Claude handles fine but weak coders fail at
catastrophically — see [the docstring in `index.ts`](./index.ts) for the
exact failure shape we caught on job 4168 (DEVPA-225).

## Tool

- `create_file(path, content)` → `{ ok: true, path, bytes, lines }`

## Guards

1. **Line ceiling** — content >200 lines is rejected. Forces the model to
   write a stub, then grow it with Pi's built-in `edit` (which is
   SEARCH/REPLACE — Aider-style — and far more reliable). Configurable via
   `PI_CREATE_FILE_MAX_LINES`.

2. **Shape sniff** — content that starts with `[{'key':` or matches the
   `{'k1': '…', 'k2': '…', 'k3': '…'}` shape is rejected as pseudo-JSON.
   Real source files don't start that way; this shape is the Qwen3-on-new-
   file failure mode.

3. **No clobber** — if the file already exists, the call is rejected with
   a hint to use `edit` instead.

All error responses include a `hint` field pointing at the right
alternative (`edit`, or `bash_exec` with heredoc).

## Loading

The worker spawns Pi with:

```
pi --extension <repo>/infra/pi-extensions/create-file --tools read,edit,grep,find,ls,bash …
```

The `--tools` allowlist hides Pi's built-in `write` so the model can only
reach this safer surface.

## Related

- `infra/pi-extensions/bash/` — `bash_exec` tool (the heredoc escape hatch
  for genuinely-large new files).
- Pi built-in `edit` at `@earendil-works/pi-coding-agent/dist/core/tools/edit.js`
  — the SEARCH/REPLACE workhorse for editing existing files.
