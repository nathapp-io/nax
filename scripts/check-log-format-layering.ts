#!/usr/bin/env bun
/**
 * Layering guard: the logging / log-format presentation layer must NOT value-import
 * the `review` or `operations` barrels.
 *
 * Why: `src/config/loader.ts` depends on `src/logger`, which depends on
 * `src/log-format`. The `../review` barrel does `export * from "./runner"`, which
 * transitively pulls `operations` -> `implement`. A value import from that barrel
 * inside the logger-reachable chain closes a circular `__esm` init cycle in the
 * BUNDLED build: `init_config` runs `init_loader2` (logger -> log-format -> review
 * -> ... -> operations -> implement) before `init_selectors2` assigns the config
 * selectors, so `implementerOp.config` binds an undefined selector. Every bundled
 * run then crashes at the implementer phase with
 * `undefined is not an object (evaluating 'selector.name')`.
 *
 * `bun test` runs TS source with live ESM bindings and never exhibits this, so the
 * only defense is a static guard + importing dependency-free leaf modules
 * (e.g. `../review/severity`) instead of the barrel.
 *
 * Type-only imports are erased at compile time and are safe. Leaf imports
 * (`../review/<file>`, not the barrel) are allowed.
 */

import { Glob } from "bun";

const SCAN_DIRS = ["src/logger", "src/log-format"];
// Barrel specifiers that drag in the heavy graph. Leaf paths are intentionally NOT listed.
const FORBIDDEN_BARRELS = new Set([
  "../review",
  "../review/index",
  "../review/index.js",
  "../operations",
  "../operations/index",
  "../operations/index.js",
]);

// Matches `import ... from "<spec>"` and `export ... from "<spec>"`, capturing whether
// it is a type-only import (erased — safe) and the module specifier.
const IMPORT_RE = /^\s*(?:import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/;

const violations: string[] = [];

for (const dir of SCAN_DIRS) {
  const glob = new Glob("**/*.ts");
  for await (const rel of glob.scan({ cwd: dir, absolute: false })) {
    const path = `${dir}/${rel}`;
    const text = await Bun.file(path).text();
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = IMPORT_RE.exec(lines[i]);
      if (!m) continue;
      const isTypeOnly = Boolean(m[1]);
      const spec = m[2];
      if (isTypeOnly) continue; // erased — no runtime cycle
      if (FORBIDDEN_BARRELS.has(spec)) {
        violations.push(`${path}:${i + 1}  value import from "${spec}" barrel`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    "[FAIL] log-format layering guard: presentation layer must not value-import review/operations barrels.",
  );
  console.error("       Import a dependency-free leaf (e.g. ../review/severity) instead of the barrel.");
  console.error("       See scripts/check-log-format-layering.ts for the circular-init rationale.\n");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`OK: log-format layering clean (scanned ${SCAN_DIRS.join(", ")}).`);
