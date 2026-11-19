/**
 * Where a bot review finding's lines came from (spec bot-convergence-facts US-005).
 *
 * `nax bot fix` records every push it makes in its own `fix-summary` comment (`bot/push-ledger.ts`).
 * This module turns that record into a fact about one finding: `git blame` names the commit that wrote
 * the line, and a recorded push owns that line when the commit is the push itself or a commit the push
 * added after its own base. The newest such push is the answer, so a finding raised on a line a later
 * fix rewrote is attributed to the later fix.
 *
 * Nothing here posts or decides anything: a missing answer is `unknown`, an unreachable record is
 * counted, and a review without a ledger asks git nothing at all. That keeps a Git failure a fact about
 * the review's confidence rather than a reason to abort it.
 */
import { getSafeLogger } from "@/logger";
import { botGit } from "./git";
import type { BotPushEntry, FindingLineage } from "./push-ledger";

/** What one recorded bot push says about a finding, and whether that answer was reachable at all. */
export interface LineageResult {
  readonly lineage: ReadonlyMap<string, FindingLineage>;
  readonly unknown: ReadonlySet<string>;
  readonly unreachable: number;
}

/** A finding whose lines to attribute: the identity it is keyed by, and the line it points at. */
export interface LineageTarget {
  readonly key: string;
  readonly file?: string;
  readonly line?: number;
}

export interface LineageInput {
  readonly targets: readonly LineageTarget[];
  readonly entries: readonly BotPushEntry[];
  readonly worktree: string;
  readonly head: string;
}

export interface LineageGitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LineageDeps {
  readonly runGit: (args: string[], workdir: string) => Promise<LineageGitResult>;
}

export const _lineageDeps: LineageDeps = {
  runGit: (args, workdir) => botGit(args, workdir),
};

/**
 * Three answers, never two: `git merge-base --is-ancestor` exits 0 for yes and 1 for no, so any other
 * exit code — or a git that could not be spawned — is a question that went unanswered, not a "no".
 */
type Answer = "yes" | "no" | "error";

const BLAMED_SHA = /^[0-9a-f]{40}$/;

async function ancestry(deps: LineageDeps, worktree: string, ancestor: string, descendant: string): Promise<Answer> {
  try {
    const { exitCode } = await deps.runGit(["merge-base", "--is-ancestor", ancestor, descendant], worktree);
    if (exitCode === 0) return "yes";
    return exitCode === 1 ? "no" : "error";
  } catch {
    // No git process answered: an unanswered question, which a caller must not read as evidence of absence.
    return "error";
  }
}

interface Reachability {
  readonly reachable: readonly BotPushEntry[];
  readonly unreachable: number;
}

/** Only a push the reviewed head can reach may own a line; a rewritten or rebased one is counted. */
async function reachableEntries(input: LineageInput, deps: LineageDeps): Promise<Reachability> {
  const reachable: BotPushEntry[] = [];
  let unreachable = 0;
  for (const entry of input.entries) {
    const answer = await ancestry(deps, input.worktree, entry.sha, input.head);
    if (answer === "yes") {
      reachable.push(entry);
      continue;
    }
    unreachable++;
    if (answer === "error")
      getSafeLogger()?.warn("bot", "Could not tell whether a recorded bot push is in the head's history", {
        sha: entry.sha,
        head: input.head,
      });
  }
  return { reachable, unreachable };
}

/** The commit `git blame` names for one line, or undefined when the line could not be read. */
async function blameCommit(
  at: { readonly file: string; readonly line: number },
  input: LineageInput,
  deps: LineageDeps,
): Promise<string | undefined> {
  try {
    const { exitCode, stdout } = await deps.runGit(
      ["blame", "--porcelain", "-L", `${at.line},${at.line}`, input.head, "--", at.file],
      input.worktree,
    );
    if (exitCode !== 0) return undefined;
    // Porcelain's first line is `<sha> <original line> <final line>`; the sha is all this module needs.
    const blamed = stdout.split("\n")[0]?.split(" ")[0] ?? "";
    return BLAMED_SHA.test(blamed) ? blamed : undefined;
  } catch {
    return undefined;
  }
}

/** The commit itself, or one the push added on top of its base — never a line its base already held. */
async function matchesEntry(
  blamed: string,
  entry: BotPushEntry,
  input: LineageInput,
  deps: LineageDeps,
): Promise<Answer> {
  if (blamed === entry.sha) return "yes";
  const added = await ancestry(deps, input.worktree, blamed, entry.sha);
  if (added !== "yes") return added;
  const before = await ancestry(deps, input.worktree, blamed, entry.base);
  if (before === "error") return "error";
  return before === "yes" ? "no" : "yes";
}

/** One past the highest generation the push fixed, naming every item it fixed as a parent. */
function lineageOf(entry: BotPushEntry): FindingLineage {
  return {
    generation: 1 + Math.max(0, ...entry.items.map(({ generation }) => generation)),
    parents: entry.items.map(({ key }) => key),
    pushSha: entry.sha,
  };
}

interface TargetOutcome {
  readonly lineage?: FindingLineage;
  readonly unknown: boolean;
}

async function targetLineage(
  target: LineageTarget,
  reachable: readonly BotPushEntry[],
  input: LineageInput,
  deps: LineageDeps,
): Promise<TargetOutcome> {
  const { file, line } = target;
  if (file === undefined || line === undefined) return { unknown: false };
  const blamed = await blameCommit({ file, line }, input, deps);
  if (blamed === undefined) return { unknown: true };
  let matched: BotPushEntry | undefined;
  for (const entry of reachable) {
    const answer = await matchesEntry(blamed, entry, input, deps);
    // A check that could not run makes this finding's answer unknown, whatever an earlier push said.
    if (answer === "error") return { unknown: true };
    if (answer === "yes") matched = entry;
  }
  return { unknown: false, ...(matched === undefined ? {} : { lineage: lineageOf(matched) }) };
}

/** Attribute every target's line to the newest push that wrote it. */
export async function computeLineage(input: LineageInput, deps: LineageDeps = _lineageDeps): Promise<LineageResult> {
  const { reachable, unreachable } = await reachableEntries(input, deps);
  const lineage = new Map<string, FindingLineage>();
  const unknown = new Set<string>();
  // With no reachable push every line is generation 0 by definition, so git is not asked anything.
  if (reachable.length === 0) return { lineage, unknown, unreachable };
  for (const target of input.targets) {
    const outcome = await targetLineage(target, reachable, input, deps);
    if (outcome.unknown) unknown.add(target.key);
    else if (outcome.lineage !== undefined) lineage.set(target.key, outcome.lineage);
  }
  return { lineage, unknown, unreachable };
}
