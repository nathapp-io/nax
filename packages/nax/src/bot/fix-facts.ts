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
import { existsSync } from "node:fs";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import { canonicalizeDeclaredPath, getContextFiles, getExpectedFiles, loadPRD, type PRD } from "@/prd";
import { storyWorkdir } from "@/utils/path-frame";
import { type FindingTrigger, isBlockingFinding } from "@/workflow/blocking-findings";
import { botGit } from "./git";
import type { AgreedItem } from "./post";
import { type BotPushEntry, type FindingLineage, parentIssue } from "./push-ledger";

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

/**
 * The one `Lineage:` line a finding gets (#2998): the generation, the push whose lines it sits on, and
 * every parent of that push it descends from — joined, so a finding with several parents states its
 * lineage once instead of repeating the push for each. The `(<issue>)` suffix is only meaningful when
 * the lineage names a single parent; a multi-parent finding's parents are listed, with their issues,
 * once per push in `lineagePushFacts`.
 */
function lineageLine(lineage: FindingLineage, entries: readonly BotPushEntry[]): string {
  const { generation, parents, pushSha } = lineage;
  const only = parents.length === 1 ? parents[0] : undefined;
  const written = `generation ${generation}, on lines added by nax bot fix ${pushSha.slice(0, SHORT_SHA_LENGTH)} for ${parents.join(", ")}`;
  const issue = only === undefined ? undefined : parentIssue(pushSha, only, entries);
  return `Lineage: ${written}${issue === undefined ? "" : ` (${issue})`}`;
}

function lineageLines(lineage: FindingLineage, entries: readonly BotPushEntry[]): string[] {
  return lineage.parents.length === 0 ? [] : [lineageLine(lineage, entries)];
}

/**
 * What the fix prompt states about one agreed item. Empty for a thread or comment item: neither sits
 * on a line a blame could attribute, and neither is a finding of the review's code pass.
 *
 * `entries` supplies each parent's issue from the push the lineage names — the ledger is the only
 * record of what an earlier fix fixed, so a parent the ledger no longer holds renders without one
 * rather than with an issue another push recorded for the same recurring key.
 */
export function findingFactLines(
  item: AgreedItem,
  entries: readonly BotPushEntry[],
  blocking: readonly FindingTrigger[],
): readonly string[] {
  if (item.kind !== "finding") return [];
  return [
    ...triggerLine(item),
    ...(item.lineage === undefined ? [] : lineageLines(item.lineage, entries)),
    ...(isBlockingFinding(item, blocking) ? [] : [NOT_BLOCKING_LINE]),
  ];
}

/** One parent of a push, with the issue that push recorded for it when the ledger still holds it. */
export interface LineagePushItem {
  readonly key: string;
  readonly issue?: string;
}

/** A push multi-parent lineages name: its short sha and the items it fixed, in first-seen order. */
export interface LineagePushFact {
  readonly sha: string;
  readonly items: readonly LineagePushItem[];
}

/** One push's item list while it is being read; `keys` keeps the dedupe O(1). */
interface PushItems {
  readonly keys: Set<string>;
  readonly items: LineagePushItem[];
}

/**
 * The items of each push that a multi-parent lineage names (#2998): one entry per distinct push, in the
 * order the agreed items first name it, its keys deduplicated in first-seen order. A push several
 * findings sit on is therefore listed once instead of once per finding per parent.
 *
 * A single-parent lineage naming the same push adds nothing: its parent's issue is already on that
 * finding's own `Lineage:` line, and repeating it here is what made the prompt grow with the round.
 * A push the ledger no longer holds still gets its entry, with keys only — the same rule `Lineage:`
 * follows, so an evicted entry never lends its keys another push's issues.
 */
export function lineagePushFacts(
  agreed: readonly AgreedItem[],
  entries: readonly BotPushEntry[],
): readonly LineagePushFact[] {
  const pushes = new Map<string, PushItems>();
  for (const item of agreed) {
    if (item.kind !== "finding" || item.lineage === undefined) continue;
    const { parents, pushSha } = item.lineage;
    if (parents.length < 2) continue;
    const push = pushes.get(pushSha) ?? { keys: new Set<string>(), items: [] };
    pushes.set(pushSha, push);
    for (const parent of parents) {
      if (push.keys.has(parent)) continue;
      push.keys.add(parent);
      const issue = parentIssue(pushSha, parent, entries);
      push.items.push(issue === undefined ? { key: parent } : { key: parent, issue });
    }
  }
  return [...pushes].map(([pushSha, push]) => ({ sha: pushSha.slice(0, SHORT_SHA_LENGTH), items: push.items }));
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
  /** The one decision that reads the filesystem: ADR-032 R3's legacy re-spell (`canonicalizeDeclaredPath`). */
  exists: (path: string) => boolean;
}

export const _outsideGrowthDeps: OutsideGrowthDeps = {
  loadPRD,
  runGit: (args, workdir) => botGit(args, workdir),
  exists: existsSync,
};

/**
 * Every file the feature declares: what each story reads, must create, or is authorised to change.
 *
 * Declared paths are read as written — repo-rooted, including a path outside the story's package
 * (ADR-032 R3). The single re-spell R3 allows is honoured so a PRD written before it still credits a
 * legacy package-relative entry: a path is re-spelled into the package only when it is absent at the
 * repo root and present there. Where the path exists at the root, only the root spelling is declared,
 * so `packages/x/src/a.ts` beside a declared `src/a.ts` stays visible as growth in a different file
 * instead of being forgiven by a spelling nothing declared.
 */
function declaredPaths(prd: PRD, repoRoot: string, exists: (path: string) => boolean): ReadonlySet<string> {
  const declared = new Set<string>();
  for (const story of prd.userStories) {
    const workdir = storyWorkdir(story);
    const paths = [
      ...getContextFiles(story),
      ...getExpectedFiles(story),
      ...(story.modifiedFiles ?? []).map(({ path }) => path),
    ];
    for (const path of paths) declared.add(canonicalizeDeclaredPath(path, workdir, repoRoot, exists).path);
  }
  return declared;
}

/**
 * `git diff --numstat -z` records are `<added>\t<deleted>\t<path>` separated by NUL. A binary file
 * reports `-` for both, and a rename carries no path in that field at all: the old and the new path
 * follow as records of their own, and the destination is the one whose additions this counts. `-z` is
 * what makes that readable — plain numstat prints a compact `old => new` expression there and quotes a
 * path with unusual characters, so the last field of a line is not always a repository path.
 */
function numstatAdditions(stdout: string): { readonly path: string; readonly added: number }[] {
  const additions: { readonly path: string; readonly added: number }[] = [];
  const fields = stdout.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index] ?? "";
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const count = Number.parseInt(record.slice(0, firstTab), 10);
    // The path is read from the field itself, never from a split of the record: a path may hold a tab.
    const inline = record.slice(secondTab + 1);
    const path = inline === "" ? fields[index + 2] : inline;
    if (inline === "") index += 2;
    // A binary file names no added line to count, and a truncated record names no path.
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
    // `-z` so a rename reports its destination path instead of a compact `old => new` expression.
    const result = await deps.runGit(["diff", "--numstat", "-z", entry.base, entry.sha], read.worktree);
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
    declared = declaredPaths(await deps.loadPRD(prdPath), input.worktree, deps.exists);
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
