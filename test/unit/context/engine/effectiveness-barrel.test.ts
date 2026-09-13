/**
 * Adversarial finding (US-003): barrel-import convention for effectiveness.ts
 *
 * The production module `src/context/engine/effectiveness.ts` is part of
 * the context-engine public API. Per the project's barrel-import convention
 * (`.claude/rules/project-conventions.md`):
 *
 *   "Import from barrels (`src/routing`), never from internal paths
 *    (`src/routing/router`). This prevents singleton fragmentation in
 *    Bun's module registry."
 *
 * The flagged line was `src/context/engine/effectiveness.ts:17`:
 *
 *     import { globToRegex, normalizePath } from "./providers/static-rules";
 *
 * Both `globToRegex` and `normalizePath` are re-exported by the context-engine
 * barrel (`src/context/engine/index.ts` line 21), so the production module
 * would normally have to consume them through the barrel — not via the
 * internal subdirectory path. These tests pin that contract: the source file
 * must not bypass the barrel for any value import that the barrel already
 * re-exports.
 *
 * Exception — documented 2026-09-13 as part of the import-cycle drain
 * (`docs/plans/STATUS-import-cycles-drain.md` Task 2): `effectiveness.ts`
 * imports `globToRegex`/`normalizePath` from `./providers/static-rules`
 * deliberately. Routing them through `./index` (the context-engine barrel)
 * closes a runtime import cycle — the barrel re-exports `effectiveness.ts`
 * itself, so the import is a self-barrel edge. The symbols are values used at
 * call time, so no `import type` alternative exists. The exemption is scoped
 * to exactly these two symbols from `./providers/static-rules`; everything
 * else must still come through the barrel.
 *
 * Each test reads the source file as text and asserts on the import
 * statements it contains.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const SOURCE_PATH = join(REPO_ROOT, "src", "context", "engine", "effectiveness.ts");
const BARREL_PATH = join(REPO_ROOT, "src", "context", "engine", "index.ts");

// ─────────────────────────────────────────────────────────────────────────────
// Source loading — read once per describe, used by every assertion below.
// ─────────────────────────────────────────────────────────────────────────────

interface ImportRecord {
  /** Specifier names bound by the import (e.g. ["globToRegex", "normalizePath"]) */
  specifiers: string[];
  /** The module specifier string (e.g. "./providers/static-rules") */
  module: string;
  /** 1-based line number where the import statement begins */
  line: number;
  /** True when the import is `import type { … } from …` — exempt from the rule */
  isTypeOnly: boolean;
}

/** Match `import [type] { a, b, c as d } from "..."` and `import [type] x from "..."`. */
const IMPORT_REGEX = /^import\s+(type\s+)?(?:\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/gm;

function parseImportMatch(match: RegExpExecArray): ImportRecord {
  const isTypeOnly = Boolean(match[1]);
  const specifiersText = match[2] ?? match[3] ?? "";
  const specifiers = specifiersText
    .split(",")
    .map(
      (s) =>
        s
          .trim()
          .split(/\s+as\s+/)[0]
          ?.trim() ?? "",
    )
    .filter(Boolean);
  return {
    specifiers,
    module: match[4] ?? "",
    line: 0, // filled by the loader
    isTypeOnly,
  };
}

async function loadSourceImports(): Promise<{
  source: string;
  imports: ImportRecord[];
}> {
  const source = await Bun.file(SOURCE_PATH).text();
  const imports: ImportRecord[] = [];

  IMPORT_REGEX.lastIndex = 0;
  let match = IMPORT_REGEX.exec(source);
  while (match !== null) {
    const record = parseImportMatch(match);
    record.line = source.substring(0, match.index).split("\n").length;
    imports.push(record);
    match = IMPORT_REGEX.exec(source);
  }
  return { source, imports };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC — barrel-import convention: value imports of barrel-exported symbols
//      must come through the barrel (./index), not from internal subpaths.
// ─────────────────────────────────────────────────────────────────────────────

describe("effectiveness.ts — barrel-import convention (US-003 adversarial finding)", () => {
  // Cycle-drain exemption (see header): these two symbols may be imported
  // from the defining leaf because the barrel route closes a runtime
  // import cycle.
  const EXEMPT_SYMBOLS = new Set(["globToRegex", "normalizePath"]);
  const EXEMPT_MODULE = "./providers/static-rules";

  test("[barrel] no provider-leaf value imports beyond the cycle-drain exemption", async () => {
    const { imports } = await loadSourceImports();

    const offending = imports.filter(
      (imp) =>
        !imp.isTypeOnly &&
        imp.module.startsWith("./providers/") &&
        !(imp.module === EXEMPT_MODULE && imp.specifiers.every((s) => EXEMPT_SYMBOLS.has(s))),
    );

    expect(offending).toHaveLength(0);
  });

  test("[barrel] the cycle-drain exemption is scoped to exactly globToRegex and normalizePath", async () => {
    // Pins the exemption so it cannot widen silently: the only legal
    // provider-leaf value import is the two-symbol static-rules statement.
    const { imports } = await loadSourceImports();

    const exemptImports = imports.filter((imp) => !imp.isTypeOnly && imp.module === EXEMPT_MODULE);

    expect(exemptImports).toHaveLength(1);
    expect(exemptImports[0]?.specifiers.sort()).toEqual(["globToRegex", "normalizePath"]);
  });

  test("[barrel, boundary] type-only imports from './providers/...' are permitted (singleton-safe)", async () => {
    // `import type { X } from "./providers/static-rules"` does not import
    // a runtime value, so Bun's module registry is unaffected. The
    // project's barrel rule explicitly exempts type-only imports. This
    // boundary test pins the exemption so it cannot regress.
    const { imports } = await loadSourceImports();

    const typeOnlyProviderImports = imports.filter((imp) => imp.isTypeOnly && imp.module.startsWith("./providers/"));

    // The current source has zero type-only provider imports — the
    // exemption is exercised by negative space, not by a positive count.
    expect(typeOnlyProviderImports).toHaveLength(0);
  });

  test("[barrel] the context-engine barrel re-exports globToRegex and normalizePath", async () => {
    // Pre-condition guard: the fix path (switching the source to import
    // from the barrel) is only viable when the barrel actually re-exports
    // the symbols. If a future refactor removes them from the barrel,
    // the upstream test fails fast and points at the barrel instead of
    // leaving the downstream test to fail with a confusing module-not-found
    // error at runtime.
    const barrelSource = await Bun.file(BARREL_PATH).text();

    expect(barrelSource).toContain("globToRegex");
    expect(barrelSource).toContain("normalizePath");
  });
});
