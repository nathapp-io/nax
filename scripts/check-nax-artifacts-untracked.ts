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

/** Whether an ignore rule already covers a violating path — three-state, never guessed. */
export type IgnoreRuleStatus = "in-place" | "missing" | "unknown";

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
 *
 * `--no-index` is REQUIRED (code review, post-original-fix): every path this
 * function is called with is, by construction, tracked (`findTrackedNaxArtifacts`
 * finds them via `git ls-files -i -c`). Without `--no-index`, `git check-ignore`
 * does not report a TRACKED file as ignored even when a matching rule exists —
 * verified in a scratch repo: file tracked + `**\/.nax/scratchpad/` rule present,
 * `git check-ignore -q` exits 1, `git check-ignore --no-index -q` exits 0. Without
 * it, the `"in-place"` branch below was unreachable at every real call site, and
 * the gate always printed "no ignore rule yet" even when the rule existed and
 * `git rm --cached` was the only correct remedy — the opposite of the accuracy
 * this function exists to provide.
 *
 * THREE-STATE, matching `partitionNaxOwnedPaths` in `src/tools/git-commit.ts`:
 * exit 0 is `"in-place"`, exit 1 is `"missing"`, and anything else — a fatal
 * error (128: not a git repo, path outside the repo) or a genuinely unexpected
 * code — is `"unknown"`. `"unknown"` is never silently folded into `"missing"`;
 * see {@link formatTrackedNaxArtifactsReport} for what the report does with it.
 */
export function checkIgnoreRuleStatus(repoRoot: string, path: string): IgnoreRuleStatus {
  const proc = Bun.spawnSync(["git", "check-ignore", "--no-index", "-q", "--", path], { cwd: repoRoot });
  if (proc.exitCode === 0) return "in-place";
  if (proc.exitCode === 1) return "missing";
  return "unknown";
}

export function formatTrackedNaxArtifactsReport(
  violations: readonly string[],
  ruleStatus: (path: string) => IgnoreRuleStatus = () => "missing",
): string {
  if (violations.length === 0) {
    return "[OK] No tracked file matches a nax gitignore entry";
  }

  const ruleAlreadyInPlace = violations.filter((path) => ruleStatus(path) === "in-place");
  const ruleMissing = violations.filter((path) => ruleStatus(path) === "missing");
  const ruleUnknown = violations.filter((path) => ruleStatus(path) === "unknown");

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
  if (ruleUnknown.length > 0) {
    lines.push(
      "",
      `${ruleUnknown.length} could not be checked — \`git check-ignore\` did not give a clear answer`,
      "(a fatal error, e.g. path outside the repo, or a repo git could not read). Do not assume",
      "either remedy: run `git check-ignore --no-index -v -- <path>` yourself for each one before",
      "deciding whether it needs the ignore rule added, `git rm --cached`, or both.",
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
  const report = formatTrackedNaxArtifactsReport(violations, (path) => checkIgnoreRuleStatus(repoRoot, path));
  if (violations.length > 0) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

if (import.meta.main) {
  await main();
}
