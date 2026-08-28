#!/usr/bin/env bun
/**
 * Prevent source from open-coding the project feature-tree path.
 *
 * `<root>/.nax/features/<featureId>` is where every feature artifact lives —
 * `prd.json`, `status.json`, `stories/`, `sessions/`, `fragments/`, `context.md`.
 * It had no single owner: 38 sites across 34 files spelled it out by hand, in
 * two shapes (`join(root, ".nax", "features", …)` and `` `${root}/.nax/features/…` ``).
 * One of them dropped the `.nax` segment, so captured fragments landed in a
 * stray top-level `features/` directory that no `.nax`-scoped gitignore entry
 * covered, and a run's auto-commit swept them into the user's repo.
 *
 * Use `featureDir(root, featureId)` / `featuresDir(root)` from `@/config` for
 * paths, and `PROJECT_FEATURES_DIR` for patterns (globs, gitignore entries).
 *
 * Comments are skipped outright. Prose that must live in a string — a user-facing
 * message, an LLM prompt describing the on-disk layout — carries an explicit
 * `nax-feature-dir-allow: <reason>` marker so the exemptions stay auditable
 * rather than growing an invisible allow-list.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SCAN_ROOTS = ["src"] as const;

/** The helpers' own definitions, and the gate's own test fixtures. */
const ALLOWED_FILES = new Set(["src/config/paths.ts", "test/unit/scripts/check-feature-dir-ssot.test.ts"]);

/**
 * Everything under `src/prompts/` is LLM instruction text. Those prompts
 * describe the on-disk layout to the agent in prose, inside template literals —
 * an inline `//` marker would be sent to the model as part of the prompt, so
 * the exemption has to be by directory. Nothing here builds a real path.
 */
const ALLOWED_DIRS: readonly string[] = ["src/prompts/"];

/**
 * Both open-coded shapes:
 *   join(x, ".nax", "features", …)  — argv form, any whitespace
 *   `${x}/.nax/features/…`         — template/string form
 * The string form deliberately also catches a plain ".nax/features/" literal,
 * which is what glob patterns and gitignore entries used.
 */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [/["']\.nax["']\s*,\s*["']features["']/, /\.nax\/features/];

/** Opt-out marker for prose that must live in a string literal. */
const ALLOW_MARKER = "nax-feature-dir-allow";

/** Lines that are pure prose — comments and their continuations. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * Drop a trailing `//` comment so prose after real code is not matched. Naive on
 * purpose: a `//` inside a string literal truncates the line early, which can
 * only ever hide a violation (false negative), never invent one.
 */
function stripTrailingComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

export interface FeatureDirViolation {
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

export function findFeatureDirViolations(repoRoot: string): FeatureDirViolation[] {
  const files = SCAN_ROOTS.flatMap((root) => collectTypeScriptFiles(join(repoRoot, root)));
  const violations: FeatureDirViolation[] = [];

  for (const file of files) {
    const relPath = relative(repoRoot, file);
    if (ALLOWED_FILES.has(relPath)) continue;
    if (ALLOWED_DIRS.some((dir) => relPath.startsWith(dir))) continue;

    const lines = readFileSync(file, "utf8").split("\n");

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (isCommentLine(line) || line.includes(ALLOW_MARKER)) continue;
      const code = stripTrailingComment(line);
      if (!FORBIDDEN_PATTERNS.some((pattern) => pattern.test(code))) continue;
      violations.push({ file: relPath, line: index + 1, snippet: line.trim() });
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function formatFeatureDirViolationReport(violations: readonly FeatureDirViolation[]): string {
  if (violations.length === 0) {
    return "[OK] No open-coded .nax/features paths outside src/config/paths.ts";
  }

  const lines = [
    "[FAIL] Open-coded .nax/features path found",
    "",
    "Use featureDir(root, featureId) or featuresDir(root) from @/config for paths,",
    "and PROJECT_FEATURES_DIR for patterns (globs, gitignore entries).",
    `If the line is genuinely prose, append "// ${ALLOW_MARKER}: <reason>".`,
    "",
  ];

  for (const violation of violations) {
    lines.push(`${violation.file}:${violation.line}`);
    lines.push(`  ${violation.snippet}`);
  }

  return lines.join("\n");
}

export async function main(): Promise<void> {
  const violations = findFeatureDirViolations(process.cwd());
  const report = formatFeatureDirViolationReport(violations);
  if (violations.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

if (import.meta.main) {
  await main();
}
