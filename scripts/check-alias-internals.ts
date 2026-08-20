#!/usr/bin/env bun
/**
 * CI gate: prevent value-level `@/<dir>/<internal>` imports when
 * `src/<dir>/index.ts` exists.
 *
 * Purpose: encapsulation — production code stays on each module's public API.
 * The guard was introduced alongside the path-alias migration so that
 * mechanically rewriting `../../routing/router` to `@/routing/router` could not
 * launder a barrel violation into a passing import; that migration is complete
 * and its ratchet retired, but the encapsulation rule is permanent.
 *
 * When a module must be reachable from outside its directory without loading
 * the parent barrel — typically because the barrel closes an import cycle —
 * promote it to its own nested barrel (`x.ts` -> `x/index.ts`). An exact barrel
 * match such as `@/review/runner` is legal; an internal path is not. See
 * `src/review/{runner,semantic-categories}` and `src/execution/{helpers,story-context}`.
 *
 * NOTE: an earlier version of this comment claimed alias-internal imports
 * "fragment singletons across Bun's module registry (BUG-035)". That is not
 * correct — `@/foo/bar` and `../foo/bar` resolve to the same realpath and
 * therefore the same module instance. BUG-035 is about `mock.module()`
 * interception, and its remedy is the `_deps` injection pattern (see
 * `src/review/runner.ts`), not import spelling. The real justification for
 * this gate is encapsulation, as described above.
 *
 * Exemptions:
 *
 * 1. Type-only imports (`import type { X } from "@/foo/internal"`) — erased at
 *    compile time, so they cannot affect runtime module wiring. This matches
 *    the documented exception for `@/config/selectors` in
 *    .claude/rules/config-patterns.md.
 *
 * 2. Value imports of `@/<dir>/<internal>` from files under `test/` — a unit
 *    test's job is to exercise the unit, so reaching past a barrel is the
 *    intended behaviour rather than a violation. Without this, a test of any
 *    non-barrelled internal was unwritable: the deep-relative form was
 *    rejected by the then-active `check-deep-relatives` ratchet and the alias
 *    form was rejected here (GitHub #1647).
 *    Encapsulation is still enforced for `src/`, `bin/` and `scripts/`.
 *    `@test/<dir>/<internal>` stays enforced everywhere — shared fixtures are
 *    a real public API for tests.
 *
 * Allowed:    import { Router } from "@/routing";
 *             import type { RoutingConfig } from "@/config/selectors";
 *             import { applyConfigCompatShims } from "@/config/compat-shims";  // in test/
 * Forbidden:  import { Router } from "@/routing/router";                       // in src/
 *             import { selectors } from "@/config/selectors";                  // in src/
 *             import { makeConfig } from "@test/helpers/config";               // anywhere
 *
 * Same rule applies to `@test/<dir>/...` when `test/<dir>/index.ts` exists.
 *
 * Usage: bun scripts/check-alias-internals.ts
 * Exit 0 if clean, exit 1 if violations found.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface AliasViolation {
  file: string;
  line: number;
  importPath: string;
  suggestion: string;
}

interface BarrelMap {
  /** Set of alias prefixes that have a reachable barrel (e.g. "@/routing"). */
  barrels: Set<string>;
  /** Directory barrels shadowed by a same-named sibling file. */
  shadowed: ShadowedBarrel[];
}

/**
 * Files that legitimately contain alias-internal patterns inside string
 * literals (test fixtures or this very script). The check itself doesn't
 * parse strings, so simple regex matching false-positives here.
 */
const EXEMPT_FILES = new Set<string>([
  "scripts/check-alias-internals.ts",
  "test/unit/scripts/check-alias-internals.test.ts",
]);

// Captures the import/export prelude in group 1 (so we can detect `type`)
// and the module specifier in group 2.
const STATIC_IMPORT_RE = /((?:import|export)\s+(?:type\s+)?[^"']*?)from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT_RE = /import\(\s*["']([^"']+)["']\s*\)/g;

function isTypeOnlyImport(prelude: string): boolean {
  return /^\s*(?:import|export)\s+type\b/.test(prelude);
}

/**
 * True when the importing file is a test. Tests may reach `src/` internals
 * directly (exemption 2 above); they may not bypass `@test/` barrels.
 */
export function isTestImporter(fileRelative: string): boolean {
  return fileRelative === "test" || fileRelative.startsWith("test/");
}

/** True for a `@/...` specifier, i.e. one pointing into `src/`. */
function isSrcAlias(spec: string): boolean {
  return spec.startsWith("@/");
}

function listBarrelDirs(rootDir: string, subdir: string, prefix: string): Set<string> {
  const dirs = new Set<string>();
  const base = join(rootDir, subdir);
  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    const full = join(base, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    let hasIndex = false;
    try {
      statSync(join(full, "index.ts"));
      hasIndex = true;
    } catch {
      // no barrel at this level — recurse to find nested barrels
    }
    if (hasIndex) {
      dirs.add(`${prefix}/${entry}`);
    }
    for (const nested of listBarrelDirs(rootDir, join(subdir, entry), `${prefix}/${entry}`)) {
      dirs.add(nested);
    }
  }
  return dirs;
}

export interface ShadowedBarrel {
  /** Repo-relative path of the directory barrel that cannot be reached. */
  barrel: string;
  /** Repo-relative path of the sibling file that wins resolution. */
  shadowedBy: string;
  /** The alias that resolves to `shadowedBy` rather than `barrel`. */
  alias: string;
}

/**
 * Find directory barrels shadowed by a sibling module of the same name.
 *
 * When both `x.ts` and `x/index.ts` exist, resolution prefers the file, so
 * `@/x` never reaches `x/index.ts`. Adding an export to the barrel then looks
 * correct on disk but fails at the import site, which is exactly the confusion
 * reported in #1648. Treat the collision itself as the defect.
 */
export function findShadowedBarrels(rootDir: string, barrels: Set<string>): ShadowedBarrel[] {
  const shadowed: ShadowedBarrel[] = [];
  for (const alias of barrels) {
    const rel = alias.startsWith("@test/")
      ? join("test", alias.slice("@test/".length))
      : join("src", alias.slice("@/".length));
    const sibling = `${rel}.ts`;
    try {
      if (!statSync(join(rootDir, sibling)).isFile()) continue;
    } catch {
      continue;
    }
    shadowed.push({ barrel: `${rel}/index.ts`, shadowedBy: sibling, alias });
  }
  return shadowed.sort((a, b) => a.alias.localeCompare(b.alias));
}

export function loadBarrels(rootDir: string): BarrelMap {
  const src = listBarrelDirs(rootDir, "src", "@");
  const tst = listBarrelDirs(rootDir, "test", "@test");
  const barrels = new Set<string>([...src, ...tst]);
  // A shadowed barrel is unreachable, so it must not be suggested as the fix
  // for an internal import. The collision is reported separately.
  const shadowed = findShadowedBarrels(rootDir, barrels);
  for (const entry of shadowed) barrels.delete(entry.alias);
  return { barrels, shadowed };
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile() && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
      yield full;
    }
  }
}

function classify(importPath: string, barrels: Set<string>): { barrel: string } | null {
  let bestMatch: { barrel: string; length: number } | null = null;
  for (const barrel of barrels) {
    if (importPath === barrel) return null;
    if (importPath.startsWith(`${barrel}/`)) {
      if (!bestMatch || barrel.length > bestMatch.length) {
        bestMatch = { barrel, length: barrel.length };
      }
    }
  }
  return bestMatch ? { barrel: bestMatch.barrel } : null;
}

export function scanFileForAliasInternals(
  file: string,
  content: string,
  barrels: Set<string>,
  rootDir: string,
): AliasViolation[] {
  const violations: AliasViolation[] = [];
  const testImporter = isTestImporter(relative(rootDir, file));

  STATIC_IMPORT_RE.lastIndex = 0;
  let staticMatch: RegExpExecArray | null;
  while ((staticMatch = STATIC_IMPORT_RE.exec(content)) !== null) {
    const prelude = staticMatch[1] ?? "";
    const spec = staticMatch[2];
    if (!spec || !(spec.startsWith("@/") || spec.startsWith("@test/"))) continue;
    if (isTypeOnlyImport(prelude)) continue;
    if (testImporter && isSrcAlias(spec)) continue;
    const hit = classify(spec, barrels);
    if (!hit) continue;
    const line = content.slice(0, staticMatch.index).split("\n").length;
    violations.push({ file: relative(rootDir, file), line, importPath: spec, suggestion: hit.barrel });
  }

  DYNAMIC_IMPORT_RE.lastIndex = 0;
  let dynMatch: RegExpExecArray | null;
  while ((dynMatch = DYNAMIC_IMPORT_RE.exec(content)) !== null) {
    const spec = dynMatch[1];
    if (!spec || !(spec.startsWith("@/") || spec.startsWith("@test/"))) continue;
    if (testImporter && isSrcAlias(spec)) continue;
    const hit = classify(spec, barrels);
    if (!hit) continue;
    const line = content.slice(0, dynMatch.index).split("\n").length;
    violations.push({ file: relative(rootDir, file), line, importPath: spec, suggestion: hit.barrel });
  }

  return violations;
}

export function findAliasInternalViolations(rootDir: string): AliasViolation[] {
  const { barrels } = loadBarrels(rootDir);
  const all: AliasViolation[] = [];
  for (const sub of ["src", "test", "bin", "scripts"]) {
    for (const file of walk(join(rootDir, sub))) {
      const rel = relative(rootDir, file);
      if (EXEMPT_FILES.has(rel)) continue;
      const content = readFileSync(file, "utf8");
      all.push(...scanFileForAliasInternals(file, content, barrels, rootDir));
    }
  }
  return all;
}

export function formatShadowedBarrelReport(shadowed: readonly ShadowedBarrel[]): string {
  const lines: string[] = [
    `[FAIL] ${shadowed.length} directory barrel(s) shadowed by a same-named sibling file.`,
    "Module resolution prefers the file, so the alias never reaches the barrel:",
    "an export added to the barrel is unreachable at that specifier (#1648).",
    "Rename the sibling, or fold it into the barrel and delete it.",
    "",
  ];
  for (const s of shadowed) {
    lines.push(`  ${s.alias}`);
    lines.push(`    resolves to:  ${s.shadowedBy}`);
    lines.push(`    shadowing:    ${s.barrel}`);
  }
  return lines.join("\n");
}

export function formatAliasViolationReport(violations: readonly AliasViolation[], barrelCount: number): string {
  if (violations.length === 0) {
    return `[OK] no alias-into-internal imports (${barrelCount} barrels checked)`;
  }
  const lines: string[] = [
    `[FAIL] ${violations.length} alias-into-internal import(s) found.`,
    "Aliases must point at barrels, never internal files.",
    "",
  ];
  for (const v of violations) {
    lines.push(`  ${v.file}:${v.line}`);
    lines.push(`    found:   ${v.importPath}`);
    lines.push(`    use:     ${v.suggestion}`);
  }
  return lines.join("\n");
}

export function main(): void {
  const root = process.cwd();
  const { barrels, shadowed } = loadBarrels(root);
  if (shadowed.length > 0) {
    console.error(formatShadowedBarrelReport(shadowed));
    process.exit(1);
  }
  const violations = findAliasInternalViolations(root);
  const report = formatAliasViolationReport(violations, barrels.size);
  if (violations.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

if (import.meta.main) {
  main();
}
