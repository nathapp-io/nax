/**
 * `nax context fragments` — inspect & prune commands (US-004)
 *
 * Feature-local fragment curation on top of `listFragmentStoryIds` /
 * `deleteFragment` in `@/context/fragments`.
 *
 * Surface:
 *  - `formatFragmentsInspect`  — pure formatter; takes the listing input,
 *    produces identical output for identical input, performs no file access.
 *  - `formatFragmentsPrune`    — pure formatter; takes a prune summary.
 *  - `fragmentsInspectCommand` — thin wrapper over `listFragmentStoryIds`
 *    + reverse-graph walk over the feature PRD, prints via formatter.
 *  - `fragmentsPruneCommand`   — thin wrapper over `deleteFragment`; with a
 *    storyId removes one fragment, without it removes every fragment for
 *    the feature.
 *  - `listDependentStoryIds`   — pure helper: BFS over the *reverse* dep
 *    graph to find every story that transitively depends on the given one.
 *
 * No fragments is a successful, informative no-op for both commands.
 */

import { deleteFragment as deleteFragmentImpl, listFragmentStoryIds as listFragmentStoryIdsImpl } from "@/context";
import type { PRD } from "@/prd";
import chalk from "chalk";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _contextFragmentsDeps = {
  /** Default uses the real `loadPRD`. Tests override for AC3 verification. */
  loadPRD: async (path: string): Promise<PRD | null> => {
    const { loadPRD } = await import("@/prd");
    try {
      return await loadPRD(path);
    } catch {
      return null;
    }
  },
  /** Default resolves the on-disk `.nax` projectDir from repoRoot. */
  projectDirFor: (repoRoot: string): string => `${repoRoot}/.nax`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Reverse-graph helper — pure (US-004 AC3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the dependency graph in REVERSE: starting from `startId`, return every
 * story that transitively depends on `startId`. The PRD's `dependencies` field
 * is "this story depends on", so the reverse is "every story X where X, or
 * some ancestor of X, lists `startId` as a dependency".
 *
 * Cycles terminate via the visited set. The requesting story is never
 * returned even when a self-loop or cycle returns to it — a fragment is
 * never emitted back to its own story.
 *
 * Returns story IDs in BFS discovery order (stable).
 */
export function listDependentStoryIds(prd: PRD, startId: string): string[] {
  // Forward deps: storyId → story ids it depends on.
  const forward = new Map<string, string[]>();
  for (const story of prd.userStories) {
    forward.set(story.id, [...(story.dependencies ?? [])]);
  }

  // Reverse deps: storyId → story ids that depend on it.
  const reverse = new Map<string, string[]>();
  for (const story of prd.userStories) {
    for (const dep of forward.get(story.id) ?? []) {
      const bucket = reverse.get(dep) ?? [];
      bucket.push(story.id);
      reverse.set(dep, bucket);
    }
  }

  const reached = new Set<string>();
  const queue: string[] = [];
  for (const direct of reverse.get(startId) ?? []) {
    if (direct === startId || reached.has(direct)) continue;
    reached.add(direct);
    queue.push(direct);
  }

  while (queue.length > 0) {
    const head = queue.shift();
    if (!head) break;
    for (const next of reverse.get(head) ?? []) {
      if (next === startId || reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }

  return [...reached];
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FragmentInspectEntry {
  storyId: string;
  /** Story IDs that transitively depend on this fragment's story (AC3). */
  dependentStoryIds: readonly string[];
}

export interface FragmentsInspectOptions {
  /** Project repo root — defaults to process.cwd(). */
  dir?: string;
  /** Feature ID — required. */
  feature: string;
  /** Path to the PRD for dep-walk (defaults to `.nax/features/<id>/prd.json`). */
  prdPath?: string;
}

export interface FragmentsPruneOptions {
  /** Project repo root — defaults to process.cwd(). */
  dir?: string;
  /** Feature ID — required. */
  feature: string;
  /** When set, removes only that story's fragment; otherwise removes every fragment. */
  storyId?: string;
}

export interface FragmentsPruneSummary {
  featureId: string;
  requestedStoryId: string | undefined;
  removedStoryIds: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure formatters (US-004 AC7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the inspect listing. Pure: takes `featureId` and a pre-computed
 * listing, produces identical output for identical input, performs no
 * file access. The dep-walk must happen before this is called — this
 * function is rendering, not reading.
 */
export function formatFragmentsInspect(featureId: string, listing: readonly FragmentInspectEntry[]): string[] {
  const lines: string[] = [];

  if (listing.length === 0) {
    lines.push(chalk.yellow(`No fragments found for feature ${featureId}.`));
    return lines;
  }

  lines.push(
    chalk.bold(
      `\nFragments for feature ${featureId}  (${listing.length} fragment${listing.length === 1 ? "" : "s"})\n`,
    ),
  );

  for (const entry of listing) {
    const { storyId, dependentStoryIds } = entry;
    lines.push(chalk.bold(`  Fragment: ${storyId}`) + chalk.dim(`  [feature: ${featureId}]`));
    lines.push(chalk.dim(`  ${"─".repeat(50)}`));

    if (dependentStoryIds.length === 0) {
      lines.push(chalk.dim("    Dependents: (none)"));
    } else {
      lines.push(`    Dependents: ${dependentStoryIds.join(", ")}`);
    }
    lines.push("");
  }

  return lines;
}

/**
 * Render the prune summary. Pure: takes the summary, returns lines.
 */
export function formatFragmentsPrune(summary: FragmentsPruneSummary): string[] {
  const { featureId, requestedStoryId, removedStoryIds } = summary;
  const lines: string[] = [];

  if (removedStoryIds.length === 0) {
    lines.push(chalk.yellow(`No fragments removed for feature ${featureId}.`));
    return lines;
  }

  if (requestedStoryId !== undefined) {
    lines.push(chalk.green(`Removed fragment for ${requestedStoryId} (feature ${featureId}).`));
  } else {
    lines.push(chalk.green(`Removed ${removedStoryIds.length} fragment(s) for feature ${featureId}:`));
    for (const id of removedStoryIds) {
      lines.push(`  - ${id}`);
    }
  }

  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Thin command wrappers
// ─────────────────────────────────────────────────────────────────────────────

function resolveProjectDir(dir: string | undefined): string {
  return dir ?? process.cwd();
}

function featurePrdPath(projectDir: string, featureId: string): string {
  return `${projectDir}/features/${featureId}/prd.json`;
}

/**
 * `nax context fragments inspect -f <feature>` — list every fragment for a
 * feature, plus the transitively-dependent story IDs (AC3). No fragments is
 * a successful, informative no-op (AC2).
 *
 * Returns the process exit code (always 0 in this spec — every fragment-
 * related failure is a 0 with an informative message, never a thrown error
 * that propagates to the user; that is the spec's "informative no-op").
 */
export async function fragmentsInspectCommand(options: FragmentsInspectOptions): Promise<number> {
  const projectDir = _contextFragmentsDeps.projectDirFor(resolveProjectDir(options.dir));
  const featureId = options.feature;
  const storyIds = await listFragmentStoryIdsImpl(projectDir, featureId);

  // AC3: build the reverse-dep listing. PRD is best-effort; missing PRD
  // yields empty dependents for every fragment.
  let prd: PRD | null = null;
  const prdPath = options.prdPath ?? featurePrdPath(projectDir, featureId);
  try {
    prd = await _contextFragmentsDeps.loadPRD(prdPath);
  } catch {
    prd = null;
  }

  const listing: FragmentInspectEntry[] = storyIds.map((storyId) => ({
    storyId,
    dependentStoryIds: prd ? listDependentStoryIds(prd, storyId) : [],
  }));

  const output = formatFragmentsInspect(featureId, listing);
  for (const line of output) {
    console.log(line);
  }
  return 0;
}

/**
 * `nax context fragments prune -f <feature> [storyId]` — remove fragments.
 * With a storyId removes only that fragment (AC4). Without one removes every
 * fragment for the feature (AC5). Empty feature is a successful no-op (AC6).
 */
export async function fragmentsPruneCommand(options: FragmentsPruneOptions): Promise<number> {
  const projectDir = _contextFragmentsDeps.projectDirFor(resolveProjectDir(options.dir));
  const featureId = options.feature;

  if (options.storyId !== undefined) {
    await deleteFragmentImpl(projectDir, featureId, options.storyId);
    const summary: FragmentsPruneSummary = {
      featureId,
      requestedStoryId: options.storyId,
      removedStoryIds: [options.storyId],
    };
    for (const line of formatFragmentsPrune(summary)) {
      console.log(line);
    }
    return 0;
  }

  // Feature-wide prune: list, then delete each.
  const allIds = await listFragmentStoryIdsImpl(projectDir, featureId);
  for (const id of allIds) {
    await deleteFragmentImpl(projectDir, featureId, id);
  }

  const summary: FragmentsPruneSummary = {
    featureId,
    requestedStoryId: undefined,
    removedStoryIds: allIds,
  };
  for (const line of formatFragmentsPrune(summary)) {
    console.log(line);
  }
  return 0;
}
