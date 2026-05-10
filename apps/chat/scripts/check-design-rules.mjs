#!/usr/bin/env node
// DevPanel design-rule enforcement (DEVPA-191).
// "no plain html or css in pages or modules, just react components
//  encapsulation or legoing" — Franck. Bans:
//   1. <style> tags inside .tsx/.jsx (modules must not ship raw CSS)
//   2. inline `style={{ ... }}` props with VISUAL keys (color, background,
//      padding, margin, font, border, ...). Logical state passthrough
//      via `--c`, `--p`, `--bg` data-style vars is allowed because the
//      values still come from tokens.
//
// Globals (apps/chat/app/globals.css) and ui/card primitive comments are
// NOT scanned — only .tsx/.jsx outside the `components/ui/` shadcn dir.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const SCAN_DIRS = ["app", "components/devpanl", "components/assistant-ui"];
const VISUAL_STYLE_KEYS = [
  "color", "background", "backgroundColor", "padding", "paddingTop",
  "paddingRight", "paddingBottom", "paddingLeft", "margin", "marginTop",
  "marginRight", "marginBottom", "marginLeft", "fontSize", "fontFamily",
  "fontWeight", "lineHeight", "letterSpacing", "border", "borderColor",
  "borderRadius", "borderWidth", "boxShadow",
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(tsx|jsx)$/.test(entry.name)) yield path;
  }
}

const violations = [];

for (const sub of SCAN_DIRS) {
  const dir = join(ROOT, sub);
  try {
    for await (const file of walk(dir)) {
      const src = await readFile(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        const lineNo = i + 1;
        if (/<style\b/.test(line)) {
          violations.push({ file, lineNo, kind: "<style> block", line: line.trim() });
        }
        const styleProp = line.match(/style=\{\{([^}]+)\}\}/);
        if (styleProp) {
          const inner = styleProp[1];
          const visual = VISUAL_STYLE_KEYS.find((k) =>
            new RegExp(`(^|[\\s,])${k}\\s*:`).test(inner),
          );
          if (visual) {
            violations.push({
              file,
              lineNo,
              kind: `inline visual style (${visual})`,
              line: line.trim(),
            });
          }
        }
      });
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

if (violations.length === 0) {
  console.log("✓ design-rules: no <style> blocks or visual inline styles");
  process.exit(0);
}

console.error(`✗ design-rules: ${violations.length} violation(s):\n`);
for (const v of violations) {
  const rel = relative(ROOT, v.file);
  console.error(`  ${rel}:${v.lineNo}  [${v.kind}]`);
  console.error(`    ${v.line}`);
}
console.error(
  "\nUse className + design tokens (var(--color-*) etc), or a primitive\n" +
    "from components/ui/. See DEVPA-191.",
);
process.exit(1);
