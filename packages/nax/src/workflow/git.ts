/** Git reads the story loop needs. cwd is always the repo root (repo-rooted paths). */
import { mkdir } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { ledgerPath } from "@/advisor";
import { NaxError } from "@/errors";
import { ALWAYS_EXCLUDED, truncateDiff } from "@/review";
import { _workflowDeps } from "./step-context";

const DIFF_CONTEXT_LINES = 10;

/** The message every ledger commit carries, in both workflow and pipeline mode (`finish/advise.ts`). */
export function ledgerCommitMessage(feature: string): string {
  return `chore(${feature}): advisor decisions`;
}

function ledgerGitError(path: string, step: string, result: { stderr?: string; exitCode: number }): NaxError {
  const detail = result.stderr?.trim() || `exit ${result.exitCode}`;
  return new NaxError(`git ${step} of "${path}" failed: ${detail}`, "WORKFLOW_GIT_FAILED", {
    stage: "workflow",
    storyId: "_run",
    path,
  });
}

/**
 * Commit the advisor's ledger **alone**, when it changed (US-003).
 *
 * The pushed branch must carry the rulings the PR body cites, and nothing else ever commits them: the
 * ledger is appended outside the story loop, and both pushes run `commitAndPush` with `skipCommit`.
 * The pathspec commit keeps unrelated staged and unstaged edits out of it, and `--no-verify` matches
 * pipeline mode's ledger commit. Deliberately no `[skip ci]`: a skipped required check blocks a merge.
 *
 * True only when this call created a commit. A missing ledger is `false`, not an error; a failing git
 * operation throws, and the caller decides how loud that is (`publish` is fail-open about it).
 */
export async function commitLedger(projectDir: string, feature: string): Promise<boolean> {
  const path = relative(projectDir, ledgerPath(projectDir, feature));
  if (!(await Bun.file(ledgerPath(projectDir, feature)).exists())) return false;
  const added = await _workflowDeps.git(["add", "--", path], projectDir);
  if (added.exitCode !== 0) throw ledgerGitError(path, "add", added);
  const staged = await _workflowDeps.git(["diff", "--cached", "--quiet", "--", path], projectDir);
  if (staged.exitCode === 0) return false;
  const commit = await _workflowDeps.git(
    ["commit", "--no-verify", "-m", ledgerCommitMessage(feature), "--", path],
    projectDir,
  );
  if (commit.exitCode !== 0) throw ledgerGitError(path, "commit", commit);
  return true;
}

export async function readHead(projectDir: string): Promise<string> {
  const { stdout } = await _workflowDeps.git(["rev-parse", "HEAD"], projectDir);
  return stdout.trim();
}

/** Repo-rooted paths changed between `base` and HEAD (#2496 second-fix eligibility). Throws on a git failure. */
export async function changedFilesSince(projectDir: string, base: string): Promise<string[]> {
  const { stdout, stderr, exitCode } = await _workflowDeps.git(["diff", "--name-only", `${base}..HEAD`], projectDir);
  if (exitCode !== 0) {
    throw new NaxError(`git diff --name-only failed: ${stderr ?? ""}`.trim(), "WORKFLOW_GIT_FAILED", {
      stage: "workflow",
      storyId: "_run",
    });
  }
  return stdout.split("\n").filter((line) => line !== "");
}

/** Paths with uncommitted edits (modified, staged, untracked), minus nax-owned paths. */
export async function listUncommitted(projectDir: string): Promise<string[]> {
  const { stdout, exitCode } = await _workflowDeps.git(["status", "--porcelain", "--untracked-files=all"], projectDir);
  if (exitCode !== 0) return [];
  return stdout
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).replace(/^"|"$/g, "").split(" -> ").pop() ?? "")
    .filter((path) => path !== "" && !path.startsWith(".nax/") && !path.startsWith(".nax-"));
}

/**
 * Files the truncated diff body does not show in full, by verbatim repo-rooted path. `--stat` shortens long
 * paths (`.../migration.sql`), so without this list a reviewer cannot name what it must still read (nax#2486).
 */
function omittedFilesSection(names: string, body: string): string {
  // `--name-only -z` and the patch come from one diff queue, so they share an order: the first N
  // names are the N file headers the cut kept. Counting headers avoids parsing them (renames show the
  // old path, quoted paths, custom prefixes). The last kept header is the file the cut went through.
  const all = names.split("\0").filter((n) => n !== "");
  // A type change (file <-> symlink) is one name but two identical headers (delete + create): count it once.
  const headerLines = body.match(/^diff --git .*$/gm) ?? [];
  const headers = headerLines.filter((h, i) => h !== headerLines[i - 1]).length;
  const partial = headers > 0 ? all[headers - 1] : undefined;
  const lines = [...(partial ? [`- ${partial} (partially shown)`] : []), ...all.slice(headers).map((n) => `- ${n}`)];
  return lines.length > 0 ? `\n## Files not shown in the diff (read them yourself)\n${lines.join("\n")}\n` : "";
}

/** One file: commit list, --stat, and the full -U10 diff for from..HEAD (truncated past the review cap). */
export async function writeReviewPackage(projectDir: string, from: string, path: string): Promise<void> {
  const range = `${from}..HEAD`;
  const pathspec = ["--", ".", ...ALWAYS_EXCLUDED];
  const [log, stat, diff, names] = await Promise.all([
    _workflowDeps.git(["log", "--oneline", range], projectDir),
    _workflowDeps.git(["diff", "--stat", range, ...pathspec], projectDir),
    _workflowDeps.git(["diff", `--unified=${DIFF_CONTEXT_LINES}`, range, ...pathspec], projectDir),
    _workflowDeps.git(["diff", "--name-only", "-z", range, ...pathspec], projectDir),
  ]);
  const failed = [log, stat, diff, names].find((r) => r.exitCode !== 0);
  if (failed) {
    const detail = (failed.stderr ?? failed.stdout).trim();
    throw new NaxError(
      `git failed building review package ${range}${detail ? `: ${detail}` : ""}`,
      "WORKFLOW_REVIEW_PACKAGE_FAILED",
      { stage: "workflow", from, path },
    );
  }
  const body = truncateDiff(diff.stdout, stat.stdout);
  const omitted = body === diff.stdout ? "" : omittedFilesSection(names.stdout, body);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(
    path,
    `## Commits (${range})\n${log.stdout.trim() || "(none)"}\n\n## Stat\n${stat.stdout.trim() || "(no changes)"}\n\n## Diff\n${body}\n${omitted}`,
  );
}
