/** Git reads the story loop needs. cwd is always the repo root (repo-rooted paths). */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ALWAYS_EXCLUDED, truncateDiff } from "@/review";
import { _workflowDeps } from "./step-context";

const DIFF_CONTEXT_LINES = 10;

export async function readHead(projectDir: string): Promise<string> {
  const { stdout } = await _workflowDeps.git(["rev-parse", "HEAD"], projectDir);
  return stdout.trim();
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

/** One file: commit list, --stat, and the full -U10 diff for from..HEAD (truncated past the review cap). */
export async function writeReviewPackage(projectDir: string, from: string, path: string): Promise<void> {
  const range = `${from}..HEAD`;
  const pathspec = ["--", ".", ...ALWAYS_EXCLUDED];
  const [log, stat, diff] = await Promise.all([
    _workflowDeps.git(["log", "--oneline", range], projectDir),
    _workflowDeps.git(["diff", "--stat", range, ...pathspec], projectDir),
    _workflowDeps.git(["diff", `--unified=${DIFF_CONTEXT_LINES}`, range, ...pathspec], projectDir),
  ]);
  const body = truncateDiff(diff.stdout, stat.stdout);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(
    path,
    `## Commits (${range})\n${log.stdout.trim() || "(none)"}\n\n## Stat\n${stat.stdout.trim() || "(no changes)"}\n\n## Diff\n${body}\n`,
  );
}
