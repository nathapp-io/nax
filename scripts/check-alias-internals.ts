#!/usr/bin/env bun
/**
 * CI gate: prevent value-level `@/<dir>/<internal>` imports when
 * `src/<dir>/index.ts` exists.
 *
 * Path aliases (`@/*`, `@test/*`) are allowed, but value imports must point at
 * barrels — never internal files. Aliasing into an internal path is
 * functionally identical to a deep relative import into an internal path: it
 * fragments singletons across Bun's module registry (BUG-035) and bypasses
 * the public API of the module.
 *
 * Type-only imports (`import type { X } from "@/foo/internal"`) are exempt
 * because TypeScript erases them at compile time, so they cannot fragment
 * runtime singletons. This matches the documented exception for
 * `@/config/selectors` in .claude/rules/config-patterns.md.
 *
 * Allowed:    import { Router } from "@/routing";
 *             import type { RoutingConfig } from "@/config/selectors";
 * Forbidden:  import { Router } from "@/routing/router";
 *             import { selectors } from "@/config/selectors";
 *
 * Same rule applies to `@test/<dir>/...` when `test/<dir>/index.ts` exists.
 *
 * Usage: bun scripts/check-alias-internals.ts
 * Exit 0 if clean, exit 1 if violations found.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface AliasViolation {
  file: string;
  line: number;
  importPath: string;
  suggestion: string;
}

interface BarrelMap {
  /** Set of alias prefixes that have a corresponding barrel (e.g. "@/routing"). */
  barrels: Set<string>;
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

export function loadBarrels(rootDir: string): BarrelMap {
  const src = listBarrelDirs(rootDir, "src", "@");
  const tst = listBarrelDirs(rootDir, "test", "@test");
  return { barrels: new Set<string>([...src, ...tst]) };
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

  STATIC_IMPORT_RE.lastIndex = 0;
  let staticMatch: RegExpExecArray | null;
  while ((staticMatch = STATIC_IMPORT_RE.exec(content)) !== null) {
    const prelude = staticMatch[1] ?? "";
    const spec = staticMatch[2];
    if (!spec || !(spec.startsWith("@/") || spec.startsWith("@test/"))) continue;
    if (isTypeOnlyImport(prelude)) continue;
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

export function formatAliasViolationReport(
  violations: readonly AliasViolation[],
  barrelCount: number,
): string {
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
  const { barrels } = loadBarrels(root);
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

