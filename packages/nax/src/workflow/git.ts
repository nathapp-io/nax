/** Git reads the story loop needs. cwd is always the repo root (repo-rooted paths). */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { NaxError } from "@/errors";
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

/**
 * Files the truncated diff body does not show in full, by verbatim repo-rooted path. `--stat` shortens long
 * paths (`.../migration.sql`), so without this list a reviewer cannot name what it must still read (nax#2486).
 */
function omittedFilesSection(names: string, body: string): string {
  // `--name-only -z` and the patch come from one diff queue, so they share an order: the first N
  // names are the N file headers the cut kept. Counting headers avoids parsing them (renames show the
  // old path, quoted paths, custom prefixes). The last kept header is the file the cut went through.
  const all = names.split("\0").filter((n) => n !== "");
  const headers = (body.match(/^diff --git /gm) ?? []).length;
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
