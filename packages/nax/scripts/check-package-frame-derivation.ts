#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Gate: block the `relative(repoRoot, packageDir)` / `packageDirRelative(repoRoot,
 * packageDir)` derivation shape anywhere in `src/`.
 *
 * nax#2111. Under `execution.storyIsolation: "worktree"`, `packageDir` is
 * `<root>/.nax-wt/<storyId>/<pkg>` while `repoRoot` stays the main checkout, so
 * `relative(repoRoot, packageDir)` yields `.nax-wt/<storyId>/<pkg>` instead of
 * `<pkg>`. That value silently matches no repo-rooted path, no `appliesTo:`
 * literal, and no `.nax/mono/<pkg>/config.json` lookup — with no diagnostic.
 * The fix, established at `src/context/engine/providers/feature-context.ts` and
 * `src/context/fragments/reframe.ts`, is `storyWorkdir(story)` /
 * `request.storyWorkdir` (`@/utils/path-frame`) — PRD-declared and immune to
 * which checkout `packageDir` happens to be rooted at.
 *
 * This is a grep-level structural check, not a type-aware one: the shape
 * `relative(<x>.repoRoot, <x>.packageDir)` (member access or bare identifiers)
 * is syntactically distinctive enough that a regex catches it reliably, and a
 * false negative here is caught by the same review that would catch a missed
 * `resolvePermissions()` call.
 *
 * `src/runtime/packages.ts`'s `relativeFromRoot` / `toRelativeKey` are exempt
 * in full: they derive a REGISTRY LOOKUP KEY, not a path frame, and
 * deliberately keep the `.nax-wt/<storyId>` prefix so a worktree story's
 * per-package config overlay resolves against its own worktree-scoped key
 * rather than colliding with the main checkout's. See the allowlist below for
 * the rest of the file exemptions, and the inline
 * `nax-package-frame-allow` marker in `src/utils/path-filters.ts` for the one
 * remaining single-line exemption there (a fallback path used only by callers
 * that build `packageDir` by joining it onto `repoRoot`, where the derivation
 * is not wrong).
 *
 * IMPORTANT for anyone adding to the allowlist: this gate exists because a
 * derivation that looks safe by inspection can still be wrong. `ruleMatchesPackage`
 * (nax#2111 1b) tests a pattern against the derived prefix with a
 * suffix-anchored regex, which is immune to an extra leading segment — verified
 * by testing that the extra segment cannot BREAK a true match. But
 * `resolveNaxIgnorePatterns`'s `compileMatcher` (nax#2111 path-filters
 * follow-up) instead PREPENDS the derived prefix onto the query subject before
 * testing it against a root pattern's regex — the opposite shape, where the
 * extra segment can CREATE a false match if some root pattern happens to match
 * the prefix itself (e.g. a `.naxignore` entry of `.nax-wt/**`). That direction
 * was not tested the first time this file was written and the site was
 * wrongly declared "provably inert" as a result. Any allowlist reason invoking
 * suffix-anchoring or similar match-direction safety must say it was tested in
 * BOTH directions (extra segment breaking a match, and extra segment creating
 * one) — an untested claim here is exactly how this defect class recurs.
 *
 * Usage:
 *   bun scripts/check-package-frame-derivation.ts        # check (CI)
 *   bun scripts/check-package-frame-derivation.ts --list # print all violations
 *
 * Allow-list a single call by appending `// nax-package-frame-allow: <reason>`
 * on the line of the call.
 */

const SCAN_ROOTS = ["src"] as const;

/**
 * Files exempt in full. Each entry needs a one-line reason — see the file
 * header for the fuller rationale.
 */
const ALLOWED_FILES = new Map<string, string>([
  [
    "src/runtime/packages.ts",
    "derives a registry LOOKUP KEY (relativeFromRoot / toRelativeKey), not a path frame — the .nax-wt/<storyId> prefix is load-bearing there (nax#2069)",
  ],
  [
    "src/cli/features-acceptance.ts",
    "a CLI entry path that runs outside story isolation — repoRoot and packageDir are both real, non-worktree directories here",
  ],
  ["test/unit/scripts/check-package-frame-derivation.test.ts", "the gate's own test fixtures"],
]);

/** Opt-out marker for a single call site, with a required reason. */
const ALLOW_MARKER = "nax-package-frame-allow";

/**
 * Matches `relative(...)` / `packageDirRelative(...)` where the first argument
 * ends in `repoRoot` and the second ends in `packageDir` — with or without a
 * member-access prefix (`request.repoRoot` and bare `repoRoot` both match), and
 * with or without a `?? <fallback>` nullish-coalescing tail on the second arg
 * (`packageDir ?? repoRoot` — src/utils/path-filters.ts's shape). `\b...\b` on
 * both ends keeps `repoRootOverride` / `packageDirs` from false-firing.
 */
const DERIVATION_RE =
  /\b(?:relative|packageDirRelative)\(\s*[\w.]*\brepoRoot\b\s*,\s*[\w.]*\bpackageDir\b(?:\s*\?\?\s*[\w.]+)?\s*\)/;

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

/**
 * Drop a trailing `//` comment so prose after real code is not matched. Naive
 * on purpose: a `//` inside a string literal truncates the line early, which
 * can only ever hide a violation (false negative), never invent one.
 */
function stripTrailingComment(line: string): string {
  const idx = line.indexOf("//");
  return idx === -1 ? line : line.slice(0, idx);
}

export interface PackageFrameDerivationViolation {
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

export function findPackageFrameDerivationViolations(repoRoot: string): PackageFrameDerivationViolation[] {
  const files = SCAN_ROOTS.flatMap((root) => collectTypeScriptFiles(join(repoRoot, root)));
  const violations: PackageFrameDerivationViolation[] = [];

  for (const file of files) {
    const relPath = relative(repoRoot, file);
    if (ALLOWED_FILES.has(relPath)) continue;

    const lines = readFileSync(file, "utf8").split("\n");

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (isCommentLine(line) || line.includes(ALLOW_MARKER)) continue;
      const code = stripTrailingComment(line);
      if (!DERIVATION_RE.test(code)) continue;
      violations.push({ file: relPath, line: index + 1, snippet: line.trim() });
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function formatPackageFrameDerivationReport(violations: readonly PackageFrameDerivationViolation[]): string {
  if (violations.length === 0) {
    return "[OK] No relative(repoRoot, packageDir) / packageDirRelative(repoRoot, packageDir) package-frame derivations found";
  }

  const lines = [
    "[FAIL] Found a relative(repoRoot, packageDir)-shaped package-frame derivation",
    "",
    'Under execution.storyIsolation: "worktree", repoRoot is the main checkout while',
    "packageDir is <root>/.nax-wt/<storyId>/<pkg>, so relative(repoRoot, packageDir)",
    'yields ".nax-wt/<storyId>/<pkg>" instead of "<pkg>" and silently drops everything',
    "keyed on it (nax#2111).",
    "",
    "Use storyWorkdir(story) / request.storyWorkdir from @/utils/path-frame instead —",
    "see src/context/engine/providers/feature-context.ts for the reference pattern.",
    `If this site genuinely needs the raw derivation, append "// ${ALLOW_MARKER}: <reason>".`,
    "",
  ];

  for (const violation of violations) {
    lines.push(`${violation.file}:${violation.line}`);
    lines.push(`  ${violation.snippet}`);
  }

  return lines.join("\n");
}

export async function main(): Promise<void> {
  const violations = findPackageFrameDerivationViolations(process.cwd());
  const report = formatPackageFrameDerivationReport(violations);
  const listOnly = process.argv.includes("--list");

  if (listOnly) {
    console.log(report);
    return;
  }

  if (violations.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

if (import.meta.main) {
  await main();
}
