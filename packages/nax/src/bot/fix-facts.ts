/**
 * The facts a fix session is given about its own items (spec bot-convergence-facts US-006).
 *
 * Two kinds, both about the round the fix is in rather than about the change it was asked for. Per
 * finding: the condition class it needs (`Trigger:`), the earlier bot push whose lines it sits on
 * (`Lineage:`), and, when it cannot hold readiness, that it cannot. Per PR: how many lines earlier
 * bot fix pushes added outside the files the feature declares, which is the size of the surface the
 * review keeps finding things on.
 *
 * They are reported as facts only. No line here tells the fixer what to do with a trigger or a
 * lineage: a finding that sits on a previous fix is still a real finding, and the decision belongs
 * to the agent reading it.
 *
 * Nothing here posts or decides anything. A missing PRD, an unreadable one or a failed `git diff`
 * is `undefined` — the fix prompt then carries no growth fact — never a wrong number, because a
 * wrong count would read as evidence about the fix.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import { getContextFiles, getExpectedFiles, loadPRD, type PRD } from "@/prd";
import { storyPackageDir } from "@/utils/path-frame";
import { type FindingTrigger, isBlockingFinding } from "@/workflow/blocking-findings";
import { botGit } from "./git";
import type { AgreedItem } from "./post";
import type { BotPushItem, FindingLineage } from "./push-ledger";

/** A commit is named short, as the fix summary names a push. */
const SHORT_SHA_LENGTH = 7;

const TRIGGER_LABEL = "Trigger:";
const NOT_BLOCKING_LINE = "Not blocking readiness (minor or trigger outside the blocking set)";

/** The class a finding needs, with the reviewer's evidence when it gave one. */
function triggerLine(item: { readonly trigger?: FindingTrigger; readonly triggerEvidence?: string }): string[] {
  if (item.trigger === undefined) return [];
  const evidence = item.triggerEvidence;
  return [
    evidence === undefined ? `${TRIGGER_LABEL} ${item.trigger}` : `${TRIGGER_LABEL} ${item.trigger} - ${evidence}`,
  ];
}

/** The push a fix wrote for one parent: its generation, the short sha, and the item's own issue. */
function lineageLine(generation: number, parent: string, pushSha: string, ledger: readonly BotPushItem[]): string {
  const issue = ledger.find((entry) => entry.key === parent)?.issue;
  const written = `generation ${generation}, on lines added by nax bot fix ${pushSha.slice(0, SHORT_SHA_LENGTH)} for ${parent}`;
  return `Lineage: ${written}${issue === undefined ? "" : ` (${issue})`}`;
}

function lineageLines(lineage: FindingLineage, ledger: readonly BotPushItem[]): string[] {
  return lineage.parents.map((parent) => lineageLine(lineage.generation, parent, lineage.pushSha, ledger));
}

/**
 * What the fix prompt states about one agreed item. Empty for a thread or comment item: neither sits
 * on a line a blame could attribute, and neither is a finding of the review's code pass.
 *
 * `ledger` supplies each parent's issue — the ledger is the only record of what an earlier fix fixed,
 * so a parent it does not name renders without one rather than with an empty pair of brackets.
 */
export function findingFactLines(
  item: AgreedItem,
  ledger: readonly BotPushItem[],
  blocking: readonly FindingTrigger[],
): readonly string[] {
  if (item.kind !== "finding") return [];
  return [
    ...triggerLine(item),
    ...(item.lineage === undefined ? [] : lineageLines(item.lineage, ledger)),
    ...(isBlockingFinding(item, blocking) ? [] : [NOT_BLOCKING_LINE]),
  ];
}

/** One file's added lines, summed over every recorded push. */
export interface OutsideGrowth {
  readonly path: string;
  readonly added: number;
}

/** A recorded push, reduced to the range its diff covers. */
export interface GrowthRange {
  readonly base: string;
  readonly sha: string;
}

export interface OutsideDeclaredGrowthInput {
  /** The feature's `prd.json`; absent when the PR changes no unambiguous feature document. */
  readonly prdPath?: string;
  /** The checkout the diffs run in — the PR's own tree, never the caller's. */
  readonly worktree: string;
  readonly entries: readonly GrowthRange[];
}

export interface OutsideGrowthDeps {
  loadPRD: (path: string) => Promise<PRD>;
  runGit: (
    args: string[],
    workdir: string,
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
}

export const _outsideGrowthDeps: OutsideGrowthDeps = {
  loadPRD,
  runGit: (args, workdir) => botGit(args, workdir),
};

/**
 * Every file the feature declares: what each story reads, must create, or is authorised to change.
 * A story's declared paths are repository-relative, so a story with a `workdir` also declares them
 * under that package — the form the numstat of a package-scoped change reports.
 */
function declaredPaths(prd: PRD): ReadonlySet<string> {
  const declared = new Set<string>();
  for (const story of prd.userStories) {
    const packageDir = storyPackageDir(story);
    const paths = [
      ...getContextFiles(story),
      ...getExpectedFiles(story),
      ...(story.modifiedFiles ?? []).map(({ path }) => path),
    ];
    for (const path of paths) {
      declared.add(path);
      if (packageDir !== undefined) declared.add(join(packageDir, path));
    }
  }
  return declared;
}

/**
 * `git diff --numstat` lines are `<added>\t<deleted>\t<path>`; a binary file reports `-` for both.
 * The path is the last field because a path may itself contain a tab, and because the middle field is
 * not read: this module counts added lines only.
 */
function numstatAdditions(stdout: string): { readonly path: string; readonly added: number }[] {
  const additions: { path: string; added: number }[] = [];
  for (const line of stdout.split("\n")) {
    const [added, ...rest] = line.split("\t");
    const path = rest.at(-1);
    const count = added === undefined ? Number.NaN : Number.parseInt(added, 10);
    // A binary file, a rename summary or a truncated line names no added line to count.
    if (!Number.isFinite(count) || path === undefined || path === "") continue;
    additions.push({ path, added: count });
  }
  return additions;
}

interface GrowthRead {
  /** The declared files the growth is measured against. */
  readonly declared: ReadonlySet<string>;
  readonly worktree: string;
}

/** One push's additions outside the declared files, or undefined when the diff could not be read. */
async function pushAdditions(
  read: GrowthRead,
  entry: GrowthRange,
  deps: OutsideGrowthDeps,
): Promise<OutsideGrowth[] | undefined> {
  let stdout: string;
  try {
    const result = await deps.runGit(["diff", "--numstat", entry.base, entry.sha], read.worktree);
    if (result.exitCode !== 0) {
      getLogger()?.debug("bot-fix", "Could not diff a recorded bot push; no growth fact", {
        base: entry.base,
        sha: entry.sha,
        exitCode: result.exitCode,
      });
      return undefined;
    }
    stdout = result.stdout;
  } catch (cause) {
    getLogger()?.debug("bot-fix", "Could not diff a recorded bot push; no growth fact", {
      base: entry.base,
      sha: entry.sha,
      error: errorMessage(cause),
    });
    return undefined;
  }
  return numstatAdditions(stdout).filter(({ path, added }) => added > 0 && !read.declared.has(path));
}

/**
 * The lines earlier bot fix pushes added, per file, outside the feature's declared files — summed
 * over every recorded push. `undefined` when there is nothing reliable to report: no PRD path, an
 * unreadable PRD or a failed diff. A file nothing was added to is not growth and is left out.
 */
export async function outsideDeclaredGrowth(
  input: OutsideDeclaredGrowthInput,
  deps: OutsideGrowthDeps = _outsideGrowthDeps,
): Promise<readonly OutsideGrowth[] | undefined> {
  const { prdPath } = input;
  if (prdPath === undefined) return undefined;
  let declared: ReadonlySet<string>;
  try {
    declared = declaredPaths(await deps.loadPRD(prdPath));
  } catch (cause) {
    getLogger()?.debug("bot-fix", "Could not read the feature PRD; no growth fact", {
      prdPath,
      error: errorMessage(cause),
    });
    return undefined;
  }
  const totals = new Map<string, number>();
  const read: GrowthRead = { declared, worktree: input.worktree };
  for (const entry of input.entries) {
    const additions = await pushAdditions(read, entry, deps);
    if (additions === undefined) return undefined;
    for (const { path, added } of additions) totals.set(path, (totals.get(path) ?? 0) + added);
  }
  return [...totals].map(([path, added]) => ({ path, added }));
}
