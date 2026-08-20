// tests/worker/pi-edit-stress.test.js
//
// H2 (docs/architecture/harness-pi.md §4.4, ADR-005 H2): stress-tests pi's
// built-in `edit` tool — the Aider-style SEARCH/REPLACE tool weak coder
// models use for every file modification in this harness (pi's built-in
// `write` is banned via --tools, see pi-driver.js's PI_BUILTIN_ALLOWLIST).
//
// This is a REAL end-to-end test: it spawns the actual `pi` binary against
// a scratch git worktree and a real model provider, then verifies the
// resulting file content on disk directly (never trusting the model's own
// self-report of what it did). Three protocols, per the C7 brief:
//
//   1. A file >70KB — the exact size class that made qwen-code false-flag
//      real JS as binary (that failure was qwen-code's edit tool, not
//      pi's — see harness-pi.md's H2 row — but the class of risk is large
//      files in general, so we verify pi's edit tool specifically handles
//      one without truncation or corruption).
//   2. A multi-hunk edit — several non-contiguous `edits[]` entries in one
//      `edit` tool call, verifying every hunk landed and none clobbered
//      another.
//   3. French apostrophes in content (e.g. "l'agent a échoué sur l'édit
//      pour l'utilisateur") — the exact character class that burned 24
//      retries via shell-quoting in `gh pr create` (ZENO-339 canary,
//      documented in loop-guard/index.ts and github/index.ts). Here we
//      check it survives an EDIT round-trip, not a shell call — a
//      different mechanism, same character class, worth confirming
//      separately because SEARCH/REPLACE oldText matching is itself a
//      place unicode/quote-normalization could silently corrupt content.
//
// Anti-overfit note (ADR-005): none of these checks are Qwen3-specific.
// They exercise pi's edit tool + whatever model DRIVER_TEST_PI_MODEL (or
// the harness default) resolves to — the point is generic weak-model
// robustness, not a Qwen3 regression suite.
//
// Requires a real pi binary AND a funded provider to actually run the
// model loop — skips cleanly otherwise (see hasPiAndKey below) rather
// than failing CI/local runs that don't have DEEPINFRA_API_KEY /
// OPENAI_API_KEY wired. See "How to run" in this file's tail comment.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { homedir } from 'os';
import { join } from 'path';

const PI_BIN = process.env.PI_BIN || 'pi';
const hasPiBinary = spawnSync(PI_BIN, ['--version'], { stdio: 'ignore' }).status === 0;
// Two independent ways pi can be authenticated for a provider:
//   1. An env var API key — the agents-host convention. pi's deepinfra
//      provider (the harness default — src/worker/select-pi-model.js
//      CHEAP_DEFAULT) is wired via DEEPINFRA_API_KEY / OPENAI_API_KEY on
//      the worker (CLAUDE.md's cheap-tier harness section).
//   2. pi's own credential store (`pi login`/`pi config`, written to
//      ~/.pi/agent/auth.json) — the convention for a developer running pi
//      interactively on their own machine, independent of any env var.
//      Confirmed present and working during C7 development (2026-08-20):
//      `pi -p "hi" --provider deepinfra ...` returned a real model
//      response with zero API-key env vars set, purely off this file.
// Either is a legitimate "pi is actually usable here" signal; check both
// rather than assuming the agents-host env convention is the only path.
const hasApiKeyEnv = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPINFRA_API_KEY);
function hasStoredAuth() {
  try {
    const raw = readFileSync(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}
const hasPiAndKey = hasPiBinary && (hasApiKeyEnv || hasStoredAuth());

const PROVIDER = process.env.PI_STRESS_TEST_PROVIDER || 'deepinfra';
const MODEL = process.env.PI_STRESS_TEST_MODEL || 'Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo';
const TIMEOUT_MS = Number(process.env.PI_STRESS_TEST_TIMEOUT_MS || 180000);

function runPi(cwd, prompt) {
  const apiKeyEnv = process.env.DEEPINFRA_API_KEY
    ? { OPENAI_API_KEY: process.env.DEEPINFRA_API_KEY }
    : {};
  return spawnSync(PI_BIN, [
    '--provider', PROVIDER,
    '--model', MODEL,
    '--mode', 'json',
    '--no-session',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--tools', 'read,edit',
    '-p', prompt,
  ], {
    cwd,
    env: { ...process.env, ...apiKeyEnv },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    // Real finding from this test's own development (2026-08-20): pi
    // --mode json echoes streaming deltas of tool results (message_update
    // events carry growing partial snapshots, not just the final result),
    // so reading a >70KB file balloons the JSON stream to >1MB — spawnSync's
    // default maxBuffer (1MB) throws ENOBUFS before the process even gets
    // a chance to finish. The real driver (pi-driver.js#spawnPi) doesn't
    // have this limit — it uses async spawn() with incremental
    // stdout.on('data') chunks, no buffering ceiling — so this is purely a
    // test-harness constraint, not a pi/model behavior. Generous ceiling
    // here so the large-file case can actually execute.
    maxBuffer: 64 * 1024 * 1024,
  });
}

function makeScratchRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-edit-stress-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  return dir;
}

describe.skipIf(!hasPiAndKey)('pi edit tool stress test (H2)', () => {
  let cwd;

  beforeAll(() => {
    cwd = makeScratchRepo();
  });

  afterAll(() => {
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  it('edits a single line inside a file >70KB without truncating or corrupting the rest', { timeout: TIMEOUT_MS + 10000 }, () => {
    // Build a >70KB JS file: 2000 near-identical small functions plus one
    // unique target line to change. This is the size class from the
    // qwen-code 70KB false-flag incident (harness-pi.md H2 row) — the
    // point isn't reproducing that exact bug (it was qwen-code's tool, not
    // pi's) but confirming pi's edit tool doesn't hit a similar wall.
    const lines = [];
    for (let i = 0; i < 2000; i++) {
      lines.push(`function helper${i}() { return ${i}; } // filler line to pad file size`);
    }
    const targetIdx = 1000;
    lines[targetIdx] = 'const STRESS_TEST_MARKER = "before-edit";';
    const content = lines.join('\n') + '\n';
    expect(Buffer.byteLength(content, 'utf8')).toBeGreaterThan(70 * 1024);

    const filePath = join(cwd, 'large-file.js');
    writeFileSync(filePath, content, 'utf8');

    const result = runPi(
      cwd,
      'Read large-file.js, find the line `const STRESS_TEST_MARKER = "before-edit";` ' +
      'and use the edit tool to change it to `const STRESS_TEST_MARKER = "after-edit";`. ' +
      'Make ONLY that one change. Do not touch anything else in the file.'
    );

    expect(result.status).toBe(0);
    const after = readFileSync(filePath, 'utf8');
    expect(after).toContain('const STRESS_TEST_MARKER = "after-edit";');
    expect(after).not.toContain('const STRESS_TEST_MARKER = "before-edit";');
    // File size should be essentially unchanged (one line edited, not
    // truncated or duplicated) — allow small slack for whitespace/EOL drift.
    expect(Buffer.byteLength(after, 'utf8')).toBeGreaterThan(content.length - 200);
    expect(Buffer.byteLength(after, 'utf8')).toBeLessThan(content.length + 200);
    // Untouched filler lines survive — spot-check a few far from the edit.
    expect(after).toContain('function helper0() { return 0; }');
    expect(after).toContain('function helper1999() { return 1999; }');
  });

  it('applies a multi-hunk edit (several non-contiguous replacements in one file)', { timeout: TIMEOUT_MS + 10000 }, () => {
    const content = [
      'const CONFIG_A = "old-value-a";',
      '',
      'function unrelatedMiddleFunction() {',
      '  return 42;',
      '}',
      '',
      'const CONFIG_B = "old-value-b";',
      '',
      'function anotherUnrelatedFunction() {',
      '  return "untouched";',
      '}',
      '',
      'const CONFIG_C = "old-value-c";',
      '',
    ].join('\n');
    const filePath = join(cwd, 'multi-hunk.js');
    writeFileSync(filePath, content, 'utf8');

    const result = runPi(
      cwd,
      'Read multi-hunk.js. Using a single edit tool call with three separate ' +
      'edits, change: `const CONFIG_A = "old-value-a";` to `const CONFIG_A = "new-value-a";`, ' +
      '`const CONFIG_B = "old-value-b";` to `const CONFIG_B = "new-value-b";`, and ' +
      '`const CONFIG_C = "old-value-c";` to `const CONFIG_C = "new-value-c";`. ' +
      'Do not change unrelatedMiddleFunction or anotherUnrelatedFunction.'
    );

    expect(result.status).toBe(0);
    const after = readFileSync(filePath, 'utf8');
    expect(after).toContain('const CONFIG_A = "new-value-a";');
    expect(after).toContain('const CONFIG_B = "new-value-b";');
    expect(after).toContain('const CONFIG_C = "new-value-c";');
    expect(after).not.toContain('old-value-a');
    expect(after).not.toContain('old-value-b');
    expect(after).not.toContain('old-value-c');
    // Untouched hunks in between survive verbatim.
    expect(after).toContain('function unrelatedMiddleFunction() {\n  return 42;\n}');
    expect(after).toContain('function anotherUnrelatedFunction() {\n  return "untouched";\n}');
  });

  it('round-trips French content with apostrophes through an edit without mangling quoting', { timeout: TIMEOUT_MS + 10000 }, () => {
    // ZENO-339 canary burned 24 retries on French apostrophes escaping
    // through a SHELL call (`gh pr create`). This is a different mechanism
    // (SEARCH/REPLACE oldText matching + JSON tool-call argument encoding)
    // but the same risky character class — curly and straight apostrophes,
    // accented characters — worth confirming survives an edit round-trip
    // on its own rather than assuming "the shell fix covers this too".
    const content = [
      '// Message d\'erreur pour l\'utilisateur',
      'const ERROR_MESSAGE = "L\'agent n\'a pas pu terminer l\'opération.";',
      '',
      'function afficherMessage() {',
      '  console.log("Voici l’état actuel du système.");', // curly apostrophe U+2019
      '}',
      '',
    ].join('\n');
    const filePath = join(cwd, 'french-apostrophes.js');
    writeFileSync(filePath, content, 'utf8');

    const result = runPi(
      cwd,
      'Read french-apostrophes.js and use the edit tool to change the string ' +
      '"L\'agent n\'a pas pu terminer l\'opération." to exactly ' +
      '"L\'agent a terminé l\'opération avec succès." ' +
      'Keep the straight apostrophes exactly as shown. Do not touch anything else in the file.'
    );

    expect(result.status).toBe(0);
    const after = readFileSync(filePath, 'utf8');
    expect(after).toContain("L'agent a terminé l'opération avec succès.");
    expect(after).not.toContain("L'agent n'a pas pu terminer");
    // The untouched curly-apostrophe line and comment survive byte-for-byte.
    expect(after).toContain('// Message d\'erreur pour l\'utilisateur');
    expect(after).toContain('Voici l’état actuel du système.');
  });
});

// How to run this test locally (it's skipped by default without a funded
// provider):
//
//   1. Install pi if not already present:
//        curl -fsSL https://github.com/block/goose/releases/latest/download/... (see CLAUDE.md cheap-tier section for the real pi install path)
//        — or, if pi is already installed globally (e.g. via `npm i -g
//        @earendil-works/pi-coding-agent`), just confirm: `pi --version`
//   2. Export a funded key:
//        export DEEPINFRA_API_KEY=<key>
//        # or, to point at a different OpenAI-compatible provider:
//        export OPENAI_API_KEY=<key>
//        export PI_STRESS_TEST_PROVIDER=<provider-name>
//        export PI_STRESS_TEST_MODEL=<model-id>
//   3. Run just this file:
//        npx vitest run tests/worker/pi-edit-stress.test.js
//
// Each test spawns a real pi process with a real model call — expect
// 10-60s per test and non-zero token spend on whichever provider is
// configured. CI does not set DEEPINFRA_API_KEY/OPENAI_API_KEY for this
// purpose today, so this suite is a manual/local verification tool, not a
// CI gate — it will report `skipped` in `npx vitest run` output in every
// environment that doesn't opt in.
