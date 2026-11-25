/**
 * The repository facts a compaction is given.
 *
 * A compaction's prompt carries facts, not orders: which features this repository
 * has and how far each has got, which branches this checkout holds, and what the
 * last few commits on `HEAD` said. This module reads those three, and nothing else
 * — the candidates and the fill come from the caller.
 *
 * Every read is best effort, and each costs only its own list. A directory outside
 * a git repository, a git that refuses or a history with no commits leaves its
 * list empty, and a feature directory with no readable `prd.json` is left out;
 * none of them can fail the read or take another list down with it. That matters
 * because the caller's next step is a billed model call: a compaction that ran on
 * the notes alone is worth making, and one that threw is not.
 *
 * The commit list is `--first-parent`, and capped. First-parent is what makes it a
 * summary of this branch rather than of every subject ever merged into it: a merge
 * contributes its own subject, and the side branch's commits stay out. The cap
 * bounds the prompt for a repository that has been running for years, and it is
 * the same number git is asked for, so the truncation happens in git.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { featuresDir } from "@/config";
import { countStories, loadPRD } from "@/prd";
import type { MemoryCompactInput } from "@/prompts";
import { gitWithTimeout } from "@/utils/git";

/** The most commit subjects a read returns, and the number git is asked for. */
const MAX_COMMIT_SUBJECTS = 300;

/** Newest first, because that is the order the prompt reads them in. */
const COMMIT_ARGS: readonly string[] = [
  "log",
  "--first-parent",
  "-n",
  String(MAX_COMMIT_SUBJECTS),
  "--format=%s",
  "HEAD",
];

/** The local branches only — a remote-tracking ref is another machine's checkout. */
const BRANCH_ARGS: readonly string[] = ["for-each-ref", "--format=%(refname:short)", "refs/heads"];

/** The repository facts a compaction is given, in the shape the prompt reads them. */
export interface MemoryCompactFacts {
  /** How far each feature under `.nax/features` has got; empty when it holds none. */
  readonly features: MemoryCompactInput["features"];
  /** The local branch names; empty outside a git repository. */
  readonly branches: readonly string[];
  /** The newest first-parent subjects of `HEAD`, newest first; empty outside a git repository. */
  readonly commits: readonly string[];
}

/**
 * The seams a read goes through. `git` is listed here so a test can drive a failed
 * log or branch listing — the two failures git reports without throwing — and
 * `loadPRD` so a test can drive a `prd.json` read that throws for a reason no
 * fixture file can produce portably.
 */
export const _compactFactsDeps: { git: typeof gitWithTimeout; loadPRD: typeof loadPRD } = {
  git: gitWithTimeout,
  loadPRD,
};

/** One feature's story counts, as the prompt reads them. */
type FeatureFacts = MemoryCompactInput["features"][number];

/** File-name order, as code units: a read's feature order is not the OS's. */
function codeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The lines one git command printed, or nothing.
 *
 * Both ways git fails land here as `[]`: a non-zero exit (not a repository, no
 * commits yet, a ref git cannot resolve) and a command that could not be run at
 * all. Neither is an error the compaction can act on, and neither may reach the
 * caller.
 */
async function gitLines(args: readonly string[], repoRoot: string): Promise<readonly string[]> {
  try {
    const { stdout, exitCode } = await _compactFactsDeps.git([...args], repoRoot);
    if (exitCode !== 0) return [];
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    // Best effort: the compaction runs on the notes alone rather than not at all.
    return [];
  }
}

/**
 * One feature's story counts, or `null` for a directory that is not a readable
 * feature.
 *
 * A `prd.json` can be missing (a feature whose planning never finished), corrupt
 * (a write that was interrupted) or unreadable. Each is the same thing to a
 * compaction — no facts from that directory — so each is skipped rather than
 * logged or thrown: the feature tree is a user's working state, not a contract
 * this read may enforce.
 */
async function readFeature(dir: string, name: string): Promise<FeatureFacts | null> {
  try {
    const prd = await _compactFactsDeps.loadPRD(join(dir, name, "prd.json"));
    const { passed, total } = countStories(prd);
    return { name, passed, total };
  } catch {
    return null;
  }
}

/**
 * Every feature under `.nax/features`, in name order, with its story counts.
 *
 * A missing or unlistable feature directory is an empty list, which is the same
 * answer a repository that has never run nax gives: the call runs on the notes
 * alone.
 */
async function readFeatures(repoRoot: string): Promise<MemoryCompactInput["features"]> {
  const dir = featuresDir(repoRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // No feature tree: nothing shipped here that a note could be measured against.
    return [];
  }
  const facts = await Promise.all(names.sort(codeUnitOrder).map((name) => readFeature(dir, name)));
  return facts.filter((fact): fact is FeatureFacts => fact !== null);
}

/**
 * Read the repository facts for a compaction.
 *
 * The three reads run concurrently and independently: each answers with an empty
 * list rather than throwing, so a failed `git log` cannot lose the feature facts
 * that were read alongside it.
 *
 * @param repoRoot - Absolute path to the repository root (the `.nax` and git anchor)
 */
export async function readMemoryCompactFacts(repoRoot: string): Promise<MemoryCompactFacts> {
  const [features, branches, commits] = await Promise.all([
    readFeatures(repoRoot),
    gitLines(BRANCH_ARGS, repoRoot),
    gitLines(COMMIT_ARGS, repoRoot),
  ]);
  return { features, branches, commits: commits.slice(0, MAX_COMMIT_SUBJECTS) };
}
