#!/usr/bin/env bun
/**
 * Prevent source and tests from constructing real ~/.nax paths directly.
 *
 * Production code should go through shared path helpers like globalConfigDir(),
 * getRunsDir(), getEventsRootDir(), or runtime path utilities. Tests should use
 * the isolated global dir from test/preload.ts unless they are explicitly
 * verifying the fallback behavior of globalConfigDir().
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SCAN_ROOTS = ["src", "test"] as const;

const ALLOWED_FILES = new Set([
  "src/config/paths.ts",
  "test/integration/config/paths.test.ts",
  "test/unit/scripts/check-no-real-global-nax.test.ts",
]);

const FORBIDDEN_PATTERN = /\b(?:path\.)?join\(\s*(?:os\.)?homedir\(\)\s*,\s*["']\.nax["']/g;

export interface GlobalNaxViolation {
  file: string;
  line: number;
  snippet: string;
}

function collectTypeScriptFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTypeScriptFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      out.push(fullPath);
    }
  }

  return out;
}

export function findForbiddenGlobalNaxUsages(repoRoot: string): GlobalNaxViolation[] {
  const files = SCAN_ROOTS.flatMap((root) => collectTypeScriptFiles(join(repoRoot, root)));
  const violations: GlobalNaxViolation[] = [];

  for (const file of files) {
    const relPath = relative(repoRoot, file);
    if (ALLOWED_FILES.has(relPath)) continue;

    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");

    for (let index = 0; index < lines.length; index++) {
      if (!FORBIDDEN_PATTERN.test(lines[index] ?? "")) continue;
      violations.push({
        file: relPath,
        line: index + 1,
        snippet: (lines[index] ?? "").trim(),
      });
      FORBIDDEN_PATTERN.lastIndex = 0;
    }
    FORBIDDEN_PATTERN.lastIndex = 0;
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function formatGlobalNaxViolationReport(violations: GlobalNaxViolation[]): string {
  if (violations.length === 0) {
    return "[OK] No direct ~/.nax path construction found outside approved helpers/tests";
  }

  const lines = [
    "[FAIL] Direct ~/.nax path construction found",
    "",
    "Use shared helpers like globalConfigDir(), getRunsDir(), getEventsRootDir(),",
    'or runtime path utilities instead of join(homedir(), ".nax", ...).',
    "",
  ];

  for (const violation of violations) {
    lines.push(`${violation.file}:${violation.line}`);
    lines.push(`  ${violation.snippet}`);
  }

  return lines.join("\n");
}

export async function main(): Promise<void> {
  const violations = findForbiddenGlobalNaxUsages(process.cwd());
  const report = formatGlobalNaxViolationReport(violations);
  if (violations.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
