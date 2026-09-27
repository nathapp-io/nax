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
import { isWithinPackage, normalizeWorkdir, toPosix } from "@/utils/path-frame";
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

/** One declared path a canonicalization pass re-spelled into the repo frame (US-001). */
export type RespelledDeclaredPath = {
  readonly storyId: string;
  readonly field: "contextFiles" | "expectedFiles" | "modifiedFiles";
  readonly from: string;
  readonly to: string;
};

/**
 * Normalise a declared path's SPELLING only — never its frame (US-001).
 *
 * Posix separators, no leading "./" runs, no trailing "/", trimmed. A path
 * that is already spelled this way is returned unchanged, byte for byte.
 *
 * Shares `toPosix` with the frame primitives, so "a spelling the normaliser
 * would change" means exactly one thing across the module pair.
 */
export function normalizeDeclaredPathSpelling(path: string): string {
  return toPosix(path);
}

/**
 * Keep a declared path in its repo-rooted frame, re-spelling it into `workdir`
 * only when that is demonstrably what the author meant (US-001, nax#2270).
 *
 * A story under `packages/lib` that creates `docs/pipelines/report.pipeline.json`
 * means the repo-rooted file, not `packages/lib/docs/...`; an `apps/api` story
 * reading `packages/db/src/schema.ts` means the repo-rooted sibling package,
 * not `apps/api/packages/db/...`. Declared paths are therefore taken as
 * written, and the only re-spell is the one case the filesystem can prove:
 *
 * 1. `p = normalizeDeclaredPathSpelling(path)`.
 * 2. At the repo root, or when `p` already lies inside `workdir`, return `p`
 *    unchanged — no filesystem probe.
 * 3. When `exists(repoRoot/p)` is false and `exists(repoRoot/workdir/p)` is
 *    true, re-spell into `workdir` and report `respelled: true`. This is the
 *    only case in which a path is re-framed, and it is the only place a stray
 *    package-relative spelling is caught.
 * 4. Otherwise return `p` unchanged. That covers existing repo-rooted files,
 *    other packages' files (R5 makes cross-package declared paths a designed
 *    case), and paths that exist nowhere — files the story will create. A path
 *    that exists both at the root and under the package reads as repo-rooted.
 *
 * The probe is only consulted on the two lookups step 3 names, so a caller at
 * the repo root or with an already-package-rooted path does no I/O at all.
 */
export function canonicalizeDeclaredPath(
  path: string,
  workdir: string,
  repoRoot: string,
  exists: ExistsProbe,
): { path: string; respelled: boolean } {
  const p = normalizeDeclaredPathSpelling(path);
  const packageWorkdir = normalizeWorkdir(workdir);
  if (packageWorkdir === "." || isWithinPackage(p, packageWorkdir)) return { path: p, respelled: false };
  if (exists(join(repoRoot, p))) return { path: p, respelled: false };
  if (exists(join(repoRoot, packageWorkdir, p))) return { path: `${packageWorkdir}/${p}`, respelled: true };
  return { path: p, respelled: false };
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
 * Re-spelling is a pure function of `path`, `workdir` and the filesystem: a
 * declared path is re-framed only when it is absent at the repo root and
 * present under `workdir`, and every such re-spell is reported in `respelled`
 * so the caller can log it (US-001).
 *
 * `opts.only` restricts the whole pass to a subset of stories and `opts.derive`
 * turns derivation off; see {@link CanonicalizeOptions} for why a scoped caller
 * needs both. Omitting `opts` is the whole-PRD behaviour `nax plan` uses.
 */
/** Options for {@link canonicalizePrdWorkdirs}. Both default to today's whole-PRD behaviour. */
export interface CanonicalizeOptions {
  /**
   * Restrict canonicalization to these story ids. A story outside the set is
   * returned by IDENTITY -- not respread -- and does not contribute to the
   * returned report.
   *
   * `nax plan --decompose` (nax#2080) writes into a PRD whose other stories may
   * already have executed. Re-spelling their paths is harmless, but re-deciding
   * anything about them is not, and one scope for the whole write is simpler to
   * reason about than separate guards.
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
): { prd: PRD; defaulted: string[]; respelled: RespelledDeclaredPath[] } {
  const defaulted: string[] = [];
  const respelled: RespelledDeclaredPath[] = [];
  const deriveEnabled = opts?.derive ?? true;

  // A stated root remains distinct from an absent workdir, including on a
  // second pass after the root workdir was omitted from the written PRD.
  const decideWorkdir = (story: UserStory, declared: readonly string[]): { workdir: string; source: WorkdirSource } => {
    if (story.workdir === "." || (story.workdir === undefined && story.workdirSource === "stated")) {
      return { workdir: ".", source: "stated" };
    }
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

    // One re-spell entry per path the write step re-framed, tagged with the
    // field it came from. `from` is the declared spelling as it stood in the
    // PRD, not the normalised one, so the report quotes what the author wrote.
    const reframe = (field: RespelledDeclaredPath["field"], path: string): string => {
      const result = canonicalizeDeclaredPath(path, workdir, repoRoot, exists);
      if (result.respelled) respelled.push({ storyId: story.id, field, from: path, to: result.path });
      return result.path;
    };

    const contextFiles = story.contextFiles?.map((entry) =>
      typeof entry === "string"
        ? reframe("contextFiles", entry)
        : { ...entry, path: reframe("contextFiles", entry.path) },
    );
    const expectedFiles = story.expectedFiles?.map((path) => reframe("expectedFiles", path));
    const modifiedFiles = story.modifiedFiles?.map((entry) => ({
      ...entry,
      path: reframe("modifiedFiles", entry.path),
    }));

    return {
      ...rest,
      ...(workdir === "." ? {} : { workdir }),
      workdirSource: source,
      ...(contextFiles !== undefined ? { contextFiles } : {}),
      ...(expectedFiles !== undefined ? { expectedFiles } : {}),
      ...(modifiedFiles !== undefined ? { modifiedFiles } : {}),
    };
  });

  return { prd: { ...prd, userStories }, defaulted, respelled };
}

/** One declared path on a canonicalized story that is not in the repo frame. */
export interface NonCanonicalDeclaredPath {
  readonly storyId: string;
  readonly field: "contextFiles" | "expectedFiles" | "modifiedFiles";
  readonly path: string;
}

/**
 * Plan-WRITE-time invariant check (design §4 PR3 bullet 3): every declared path
 * on a story that canonicalizePrdWorkdirs has stamped (workdirSource defined)
 * should be spelled canonically -- a path is canonical iff
 * normalizeDeclaredPathSpelling leaves it byte-identical.
 *
 * The rule is about SPELLING, not framing (US-001). A repo-rooted path outside
 * the story's package (`docs/x.md` on a `packages/lib` story, a cross-package
 * `modifiedFiles` entry) is a designed case -- R5 -- and is no longer flagged.
 * Accepted tradeoff: a bare package-relative `src/a.ts` on a `packages/lib`
 * stamped story is indistinguishable from a repo-rooted `src/a.ts` without the
 * filesystem, so it is not flagged either. The existence-aware re-spell in
 * canonicalizePrdWorkdirs is now the only place that catches that input.
 *
 * A violation is evidence, not proof of a bug. Two legitimate causes produce a
 * non-canonical spelling on a stamped story: a PRD written before the
 * single-frame redesign carries a `workdirSource` stamp from the OLD
 * existence-gated canonicalizer while a create-intent path is still
 * workdir-relative; and a scoped caller (nax plan --decompose) deliberately
 * does not reframe the out-of-scope stories canonicalizePrdWorkdirs returns by
 * identity. A caller that only wants the stories a given pass touched should
 * pass just those (see finalizeAndWritePrd, nax#2080). This is NOT a
 * PRD.parse()-time schema rule: a pre-#2125 PRD with no `workdirSource` at all
 * is skipped entirely, so hand-edited and legacy PRDs keep loading.
 *
 * Returns violations rather than throwing -- the caller (finalizeAndWritePrd)
 * logs and continues, matching nax plan's recovery-tolerant contract
 * (src/operations/plan-fidelity.ts header comment).
 */
export function findNonCanonicalDeclaredPaths(prd: PRD): NonCanonicalDeclaredPath[] {
  const violations: NonCanonicalDeclaredPath[] = [];
  for (const story of prd.userStories) {
    if (story.workdirSource === undefined) continue;
    const check = (field: NonCanonicalDeclaredPath["field"], path: string): void => {
      if (normalizeDeclaredPathSpelling(path) !== path) {
        violations.push({ storyId: story.id, field, path });
      }
    };
    for (const entry of story.contextFiles ?? []) check("contextFiles", typeof entry === "string" ? entry : entry.path);
    for (const path of story.expectedFiles ?? []) check("expectedFiles", path);
    for (const entry of story.modifiedFiles ?? []) check("modifiedFiles", entry.path);
  }
  return violations;
}
