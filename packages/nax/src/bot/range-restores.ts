/**
 * nax#3050: which files an incremental range takes back toward the target branch.
 *
 * An incremental review reads only `reviewedHead..HEAD`. When that range removes code an earlier
 * commit of the pull request added (a hand reset after fix rounds, say), the reviewed head is the
 * only baseline the reviewer sees, and behaviour the target branch already has reads as a regression.
 * This reads, per file the range touches, how many lines the file differs from the merge base at the
 * reviewed head and at this head, and keeps the files where that number got smaller. It is a fact for
 * the prompt, never a rule: no threshold, no file is excused from review.
 *
 * Repo-scoped: every path is the repository-relative path git prints.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";

/** One file the range brought closer to the merge base, in lines changed (added plus deleted). */
export interface RestoredFile {
  readonly path: string;
  /** Lines the file differs from the merge base at this head. */
  readonly now: number;
  /** Lines the file differed from the merge base at the reviewed head. */
  readonly before: number;
}

/** The files to list, at most `MAX_RESTORED_FILES`, and how many qualified before the cap. */
export interface RangeRestores {
  readonly files: readonly RestoredFile[];
  readonly total: number;
}

const NO_RESTORES: RangeRestores = { files: [], total: 0 };

export type RestoreGit = (
  args: string[],
  cwd: string,
) => Promise<{ readonly stdout: string; readonly exitCode: number }>;

/** The prompt lists at most this many files, the ones the range shrank most first. */
export const MAX_RESTORED_FILES = 50;

/**
 * `--no-renames` keeps one `<added>\t<deleted>\t<path>` record per NUL, so each path is compared with
 * itself on both sides; `-z` keeps the path verbatim. A binary file reports `-` and is skipped.
 */
const NUMSTAT = ["diff", "--numstat", "-z", "--no-renames"];

function parseNumstat(stdout: string): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const record of stdout.split("\0")) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = Number.parseInt(record.slice(0, firstTab), 10);
    const deleted = Number.parseInt(record.slice(firstTab + 1, secondTab), 10);
    // The path is everything after the second tab: a path may itself hold a tab.
    const path = record.slice(secondTab + 1);
    if (!Number.isFinite(added) || !Number.isFinite(deleted) || path === "") continue;
    counts.set(path, added + deleted);
  }
  return counts;
}

async function numstat(git: RestoreGit, dir: string, range: string): Promise<ReadonlyMap<string, number>> {
  const result = await git([...NUMSTAT, range], dir);
  if (result.exitCode !== 0)
    throw new NaxError("[bot] Cannot diff the range against the merge base", "BOT_RANGE_DIFF_FAILED", {
      stage: "bot",
      range,
      exitCode: result.exitCode,
    });
  return parseNumstat(result.stdout);
}

/** The files the range `rangeBase..HEAD` takes back toward `mergeBase`; empty when git cannot say. */
export async function readRangeRestores(
  git: RestoreGit,
  dir: string,
  range: { readonly mergeBase: string; readonly rangeBase: string },
): Promise<RangeRestores> {
  try {
    const [touched, before, now] = await Promise.all([
      numstat(git, dir, `${range.rangeBase}..HEAD`),
      // Three dots: from the reviewed head's own merge base, so target-branch commits merged into
      // the range after that review do not read as the pull request's earlier change.
      numstat(git, dir, `${range.mergeBase}...${range.rangeBase}`),
      numstat(git, dir, `${range.mergeBase}..HEAD`),
    ]);
    const restored = [...touched.keys()]
      .map((path) => ({ path, now: now.get(path) ?? 0, before: before.get(path) ?? 0 }))
      .filter((file) => file.now < file.before)
      .sort((a, b) => b.before - b.now - (a.before - a.now));
    return { files: restored.slice(0, MAX_RESTORED_FILES), total: restored.length };
  } catch (error) {
    getSafeLogger()?.warn("bot", "Could not compare the range with the merge base; no restored-file facts", {
      storyId: "_run",
      error: errorMessage(error),
    });
    return NO_RESTORES;
  }
}
