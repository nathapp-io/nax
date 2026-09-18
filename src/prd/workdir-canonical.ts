/**
 * Workdir derivation and declared-path canonicalization for `nax plan` (nax#2067).
 *
 * A story with no `workdir` is not inert: rule selection falls back to the whole
 * corpus and `quality.commands` falls back to the root config, both silently.
 * This module decides a workdir from the filesystem at plan time — the one
 * moment the repo is in the state the planner described — and re-spells the
 * story's declared paths into the canonical repo frame while it is there.
 *
 * Pure by construction: every filesystem-facing function takes an `ExistsProbe`
 * rather than touching the filesystem, so the whole decision table is
 * unit-testable without fixtures. The caller supplies the real probe.
 */

import { join } from "node:path";
import { normalizeWorkdir, toRepoFrame } from "@/utils/path-frame";
import type { PRD, UserStory, WorkdirSource } from "./types";

/** Synchronous existence probe over ABSOLUTE paths. */
export type ExistsProbe = (absPath: string) => boolean;

/**
 * Every workspace package a declared path could belong to.
 *
 * Two ways a path can belong to package W:
 * - it is package-relative and `repoRoot/W/P` exists, or
 * - it already names W on a segment boundary and `repoRoot/P` exists.
 *
 * The segment boundary matters: "packages/app" must not claim
 * "packages/application/...".
 */
export function resolvePathOwners(
  path: string,
  repoRoot: string,
  packages: readonly string[],
  exists: ExistsProbe,
): string[] {
  const owners: string[] = [];
  for (const pkg of packages) {
    if (exists(join(repoRoot, pkg, path))) {
      owners.push(pkg);
      continue;
    }
    const namesPackage = path === pkg || path.startsWith(`${pkg}/`);
    if (namesPackage && exists(join(repoRoot, path))) owners.push(pkg);
  }
  return owners;
}

/**
 * Decide a workdir for a story the planner left unstated.
 *
 * Paths that resolve nowhere are ignored rather than forcing a default: a story
 * that reads one existing file and creates another is the common case, and the
 * file it creates carries no information about which package it belongs to.
 */
export function deriveWorkdir(
  declaredPaths: readonly string[],
  repoRoot: string,
  packages: readonly string[],
  exists: ExistsProbe,
): { workdir: string; source: "derived" | "defaulted" } {
  const owners = new Set<string>();
  for (const path of declaredPaths) {
    for (const owner of resolvePathOwners(path, repoRoot, packages, exists)) owners.add(owner);
  }
  if (owners.size !== 1) return { workdir: ".", source: "defaulted" };
  const [only] = [...owners];
  // biome-ignore lint/style/noNonNullAssertion: size is exactly 1
  return { workdir: only!, source: "derived" };
}

/**
 * Re-spell a declared path into the repo frame (R3, single-frame redesign).
 *
 * Unconditional pure-string normalization — no existence probe. Before this
 * change the function probed the filesystem to decide whether a workdir-
 * relative-looking path should be re-spelled, which is exactly the mechanism
 * that produced #2125's mixed-frame PRD: a path absent at plan time (because
 * the story creates it) was left workdir-relative rather than repo-rooted.
 * The planner now emits repo-rooted paths directly (src/prompts/builders/
 * plan-builder.ts, decompose-builder.ts), so this is a defensive re-spell for
 * a stray package-relative spelling, not a disambiguation — there is nothing
 * left to disambiguate. Delegates to toRepoFrame, which already implements
 * the identical segment-boundary-safe re-spell; kept as a distinct named
 * export because src/debate/verifiers/checks.ts and this module's own
 * canonicalizePrdWorkdirs both call it as "the PRD write-time re-spell",
 * a narrower and more discoverable name than the general-purpose toRepoFrame.
 */
export function canonicalizeDeclaredPath(path: string, workdir: string): string {
  return toRepoFrame(path, workdir);
}

/**
 * Canonicalize every story in a PRD: decide the workdir, stamp its provenance,
 * and re-spell declared paths into the repo frame.
 *
 * `workdir` is OMITTED rather than written as "." for a root story: "." is the
 * accessors' internal spelling, and writing it into the PRD would change the
 * on-disk shape for every single-package repo. `workdirSource` carries the
 * information instead.
 *
 * `defaulted` lists the ids of stories that fell back to root. It is RETURNED
 * rather than logged here so this module stays pure -- and because this is the
 * only point in `nax plan` where that fact is known (see the RULING in the
 * plan's Orientation section).
 *
 * Re-spelling is now a pure function of `path` and `workdir`; there is no
 * longer a filesystem-dependent ambiguity to report.
 *
 * `opts.only` restricts the whole pass to a subset of stories and `opts.derive`
 * turns derivation off; see {@link CanonicalizeOptions} for why a scoped caller
 * needs both. Omitting `opts` is the whole-PRD behaviour `nax plan` uses.
 */
/** Options for {@link canonicalizePrdWorkdirs}. Both default to today's whole-PRD behaviour. */
export interface CanonicalizeOptions {
  /**
   * Restrict canonicalization to these story ids. A story outside the set is
   * returned by IDENTITY -- not respread -- and contributes to none of the three
   * returned reports.
   *
   * `nax plan --decompose` (nax#2080) writes into a PRD whose other stories may
   * already have executed. Re-spelling their paths is harmless, but re-deciding
   * anything about them is not, and one scope for the whole write is simpler to
   * reason about than three separate guards.
   */
  readonly only?: ReadonlySet<string>;
  /**
   * Derive a workdir for a story that did not state one. Default true.
   *
   * `false` is for a caller writing into a PRD that has partly executed:
   * derivation reads the filesystem, and the answer changes once earlier stories
   * have created files, so a story that legitimately defaulted at plan time would
   * silently acquire a package. A sub-story inherits its parent's workdir
   * (ADR-025: decompose inherits, it does not re-select), so there is nothing
   * left for derivation to decide there anyway.
   */
  readonly derive?: boolean;
}

export function canonicalizePrdWorkdirs(
  prd: PRD,
  repoRoot: string,
  packages: readonly string[],
  exists: ExistsProbe,
  opts?: CanonicalizeOptions,
): { prd: PRD; defaulted: string[] } {
  const defaulted: string[] = [];
  const deriveEnabled = opts?.derive ?? true;

  // normalizeWorkdir collapses "", ".", "./" and absent to "." so a planner that
  // literally emits "." is treated as root, not as a stated package.
  const decideWorkdir = (story: UserStory, declared: readonly string[]): { workdir: string; source: WorkdirSource } => {
    const statedWorkdir = normalizeWorkdir(story.workdir);
    if (statedWorkdir !== ".") return { workdir: statedWorkdir, source: "stated" };
    if (!deriveEnabled) return { workdir: ".", source: "defaulted" };
    return deriveWorkdir(declared, repoRoot, packages, exists);
  };

  const userStories = prd.userStories.map((story) => {
    if (opts?.only && !opts.only.has(story.id)) return story;

    // `workdir` is destructured off `rest` rather than left to the conditional
    // spread below: spreading `...story` would re-introduce the raw value (a
    // literal ".", "" or "./") that normalizeWorkdir collapsed, landing it in the
    // written PRD and contradicting the omit-at-root contract. The raw field is
    // still read directly -- this module is the plan-time writer -- which is why
    // it is ALLOWED in scripts/check-story-workdir-access.ts.
    const { workdir: _rawWorkdir, ...rest } = story;
    const declared = [
      ...(story.contextFiles ?? []).map((f) => (typeof f === "string" ? f : f.path)),
      ...(story.expectedFiles ?? []),
    ];

    const { workdir, source } = decideWorkdir(story, declared);
    if (source === "defaulted") defaulted.push(story.id);

    const reframe = (path: string): string => canonicalizeDeclaredPath(path, workdir);

    const contextFiles = story.contextFiles?.map((entry) =>
      typeof entry === "string" ? reframe(entry) : { ...entry, path: reframe(entry.path) },
    );
    const expectedFiles = story.expectedFiles?.map(reframe);
    const modifiedFiles = story.modifiedFiles?.map((entry) => ({ ...entry, path: reframe(entry.path) }));

    return {
      ...rest,
      ...(workdir === "." ? {} : { workdir }),
      workdirSource: source,
      ...(contextFiles !== undefined ? { contextFiles } : {}),
      ...(expectedFiles !== undefined ? { expectedFiles } : {}),
      ...(modifiedFiles !== undefined ? { modifiedFiles } : {}),
    };
  });

  return { prd: { ...prd, userStories }, defaulted };
}
