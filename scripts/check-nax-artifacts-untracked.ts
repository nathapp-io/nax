#!/usr/bin/env bun
/**
 * Gate: no nax-owned run artifact may be git-tracked.
 *
 * `nax init` writes `NAX_GITIGNORE_ENTRIES` into the project `.gitignore` (and
 * `WorktreeManager` writes them into `.git/info/exclude`), but an ignore rule
 * does not untrack a file already in the index. `patchIgnoreFile` cannot see
 * the index, so an entry added after a repo was initialised leaves the
 * already-committed artifacts tracked, and the next `git add -A` keeps them
 * there. This gate is the recurrence stop: it asks git which tracked files
 * match the live entry list and fails when any do.
 *
 * The patterns come from `src/utils/gitignore.ts`, never re-spelled here — the
 * gate must enforce the same list `nax init` writes, or it drifts from the
 * generator it exists to police.
 *
 * Usage:
 *   bun scripts/check-nax-artifacts-untracked.ts
 *
 * Exit codes:
 *   0 — no tracked file matches a nax gitignore entry
 *   1 — one or more do (count and breakdown printed to stderr)
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { NAX_GITIGNORE_ENTRIES } from "../src/utils/gitignore";
import { byCodePoint } from "../src/utils/sort";

/**
 * Tracked files under `repoRoot` that match `NAX_GITIGNORE_ENTRIES`.
 *
 * `git ls-files -i -c --exclude-from=<temp>` is the one invocation that answers
 * exactly this question: `-c` restricts to the index, `-i` keeps only names an
 * exclude pattern matches. The patterns go in a temp file because git reads
 * excludes from a file, not from a flag.
 */
export function findTrackedNaxArtifacts(repoRoot: string): string[] {
  const excludeDir = mkdtempSync(join(tmpdir(), "nax-artifacts-check-"));
  const excludeFile = join(excludeDir, "exclude");
  try {
    writeFileSync(excludeFile, `${NAX_GITIGNORE_ENTRIES.join("\n")}\n`, "utf8");
    const proc = Bun.spawnSync(["git", "ls-files", "-i", "-c", `--exclude-from=${excludeFile}`], {
      cwd: repoRoot,
    });
    if (proc.exitCode !== 0) {
      throw new Error(`git ls-files failed in ${repoRoot}: ${proc.stderr.toString().trim()}`);
    }
    return proc.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .sort(byCodePoint);
  } finally {
    rmSync(excludeDir, { recursive: true, force: true });
  }
}

/** Per-basename tallies, ordered by name for a stable report. */
function countByBasename(violations: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const path of violations) {
    const name = basename(path);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => byCodePoint(a, b));
}

/**
 * Whether `path` is ignored by the repo's REAL ignore rule stack — `.gitignore`
 * plus `.git/info/exclude`, evaluated by git itself — as opposed to the
 * synthetic `--exclude-from` list `findTrackedNaxArtifacts` uses only to find
 * violations.
 *
 * This is what tells the two failure causes apart, which the old fixed report
 * text conflated ("the ignore rule is in place" — stated unconditionally, even
 * when it was not): a violation can be a file an ignore rule already covers
 * (only `git rm --cached` fixes it), or a file no ignore rule covers yet
 * (the rule itself is the gap; nax's own run-start reconcile or `nax init`
 * closes it, and only then does `git rm --cached` apply).
 */
export function isIgnoredByRepo(repoRoot: string, path: string): boolean {
  const proc = Bun.spawnSync(["git", "check-ignore", "-q", "--", path], { cwd: repoRoot });
  return proc.exitCode === 0;
}

export function formatTrackedNaxArtifactsReport(
  violations: readonly string[],
  isRuleInPlace: (path: string) => boolean = () => false,
): string {
  if (violations.length === 0) {
    return "[OK] No tracked file matches a nax gitignore entry";
  }

  const ruleAlreadyInPlace = violations.filter((path) => isRuleInPlace(path));
  const ruleMissing = violations.filter((path) => !isRuleInPlace(path));

  const lines = [
    `[FAIL] ${violations.length} tracked file(s) match a nax gitignore entry`,
    "",
    "nax owns these run artifacts; they must not be committed.",
  ];

  if (ruleAlreadyInPlace.length > 0) {
    lines.push(
      "",
      `${ruleAlreadyInPlace.length} already have an ignore rule in place — an ignore rule does not`,
      "untrack a file already in the index. Remedy:",
      "  git rm --cached -- <paths>",
    );
  }
  if (ruleMissing.length > 0) {
    lines.push(
      "",
      `${ruleMissing.length} have no ignore rule yet — nax adds it automatically at the start of the`,
      "next run (or run `nax init` now to add it immediately). Once the rule is in place,",
      "untrack these too:",
      "  git rm --cached -- <paths>",
    );
  }

  lines.push("", "Per-basename breakdown:");
  for (const [name, count] of countByBasename(violations)) {
    lines.push(`  ${name}: ${count}`);
  }
  return lines.join("\n");
}

export async function main(): Promise<void> {
  const repoRoot = process.cwd();
  let violations: string[];
  try {
    violations = findTrackedNaxArtifacts(repoRoot);
  } catch (err) {
    // A git failure is a gate failure, not an unhandled rejection: surface it
    // in the same [FAIL] form and exit non-zero so CI reports it as this gate.
    console.error(`[FAIL] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const report = formatTrackedNaxArtifactsReport(violations, (path) => isIgnoredByRepo(repoRoot, path));
  if (violations.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

if (import.meta.main) {
  await main();
}
