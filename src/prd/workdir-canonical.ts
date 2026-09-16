/**
 * Workdir derivation and declared-path canonicalization for `nax plan` (nax#2067).
 *
 * A story with no `workdir` is not inert: rule selection falls back to the whole
 * corpus and `quality.commands` falls back to the root config, both silently.
 * This module decides a workdir from the filesystem at plan time — the one
 * moment the repo is in the state the planner described — and re-spells the
 * story's declared paths into the canonical repo frame while it is there.
 *
 * Pure by construction: every function takes an `ExistsProbe` rather than
 * touching the filesystem, so the whole decision table is unit-testable without
 * fixtures. The caller supplies the real probe.
 */

import { join } from "node:path";
import { normalizeWorkdir, toRepoFrame } from "@/utils/path-frame";
import type { PRD, WorkdirSource } from "./types";

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
 * Re-spell one declared path into the repo frame, per the spec's four outcomes:
 *
 *   exists(repoRoot/P)   -> P             (already repo-rooted)
 *   exists(repoRoot/W/P) -> W + "/" + P   (re-spell)
 *   neither              -> P unchanged   (a file the story creates)
 *   both                 -> W + "/" + P   (story-local wins), collision reported
 *
 * `collided` is returned rather than logged so this stays pure; the caller logs.
 */
export function canonicalizeDeclaredPath(
  path: string,
  workdir: string,
  repoRoot: string,
  exists: ExistsProbe,
): { path: string; collided: boolean } {
  if (workdir === ".") return { path, collided: false };
  const atPackage = exists(join(repoRoot, workdir, path));
  const atRoot = exists(join(repoRoot, path));
  if (atPackage) return { path: toRepoFrame(path, workdir), collided: atRoot };
  return { path, collided: false };
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
 * Collisions are returned as "storyId:path" strings, and `defaulted` lists the ids of stories that
 * fell back to root, both for the caller to log. They are RETURNED rather than logged here so this
 * module stays pure -- and, for `defaulted`, because this is the only point in `nax plan` where that
 * fact is known (see the RULING in the plan's Orientation section).
 */
export function canonicalizePrdWorkdirs(
  prd: PRD,
  repoRoot: string,
  packages: readonly string[],
  exists: ExistsProbe,
): { prd: PRD; collisions: string[]; defaulted: string[] } {
  const collisions: string[] = [];
  const defaulted: string[] = [];

  const userStories = prd.userStories.map((story) => {
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

    // normalizeWorkdir collapses "", ".", "./" and absent to "." so a planner that
    // literally emits "." is treated as root, not as a stated package.
    const statedWorkdir = normalizeWorkdir(story.workdir);
    const stated = statedWorkdir !== ".";
    const { workdir, source }: { workdir: string; source: WorkdirSource } = stated
      ? { workdir: statedWorkdir, source: "stated" }
      : deriveWorkdir(declared, repoRoot, packages, exists);
    if (source === "defaulted") defaulted.push(story.id);

    const reframe = (path: string): string => {
      const result = canonicalizeDeclaredPath(path, workdir, repoRoot, exists);
      if (result.collided) collisions.push(`${story.id}:${path}`);
      return result.path;
    };

    const contextFiles = story.contextFiles?.map((entry) =>
      typeof entry === "string" ? reframe(entry) : { ...entry, path: reframe(entry.path) },
    );
    const expectedFiles = story.expectedFiles?.map(reframe);

    return {
      ...rest,
      ...(workdir === "." ? {} : { workdir }),
      workdirSource: source,
      ...(contextFiles !== undefined ? { contextFiles } : {}),
      ...(expectedFiles !== undefined ? { expectedFiles } : {}),
    };
  });

  return { prd: { ...prd, userStories }, collisions, defaulted };
}
