/**
 * The policy's path branch: containment first, then deny -> ask -> allow per
 * resolved path, across the four kinds of path-bearing input field.
 *
 * Split out of `policy.ts` (cognitive-complexity drain A8). Each field kind is
 * its own named handler, and the per-path sequence all four share — resolve,
 * refuse containment breaches, apply rules, glob-check, record — is one helper
 * whose arguments name the only things that differ between the loops: the
 * denial's subject spelling, and whether a glob miss denies.
 *
 * Behavioural shape worth naming because the handlers must not be "unified":
 * `pathFields` and `listPathFields` deny on a glob miss whenever the grant is
 * conditional (`enforcePathGlobs`), while `arrayPathFields` and `refPathFields`
 * deny only when the grant is conditional AND carries at least one path glob
 * (`restrictPaths`). A verb-only grant therefore DENIES string path fields but
 * leaves array/ref paths bounded by the root alone — pinned by `policy.test.ts`
 * ("a verb-only grant leaves paths bounded by the root alone") and
 * `policy-paths-branch-edges.test.ts`.
 *
 * Everything here is reached through `policy.ts`; this module imports nothing
 * from it (the collaborators it shares — deny, askVerdict, applyPathRules —
 * arrive by reference in `PathsBranchContext`, read at call time).
 */

import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isInside, realOrRaw } from "#src/internal/realpath";
import type { OwnedPathsPolicy } from "./owned-paths.ts";
import { pathListElements } from "./path-list.ts";
import { pathFieldValue } from "./policy-input.ts";
import { type CompiledEntry, type CompiledPattern, matchesAny } from "./policy-match.ts";
import type { PolicyVerdict, ToolScope } from "./types.ts";

/** Mutable scratch shared by `check()`'s branch helpers: first ask rule matched. */
export interface RuleState {
  ask?: string;
}

/**
 * Per-policy collaborators the path branch shares with the rest of the policy.
 * Passed by reference; every member is read at call time, so a caller that
 * rebuilds or reassigns between checks stays authoritative.
 */
export interface PathsBranchContext {
  /** The policy's containment root, symlink-resolved at compile time. */
  readonly resolvedRoot: string;
  readonly deny: (reason: string, breach?: boolean, escalatable?: boolean) => PolicyVerdict;
  readonly askVerdict: (resolvedPaths: readonly string[], rule: string) => PolicyVerdict;
  readonly applyPathRules: (tool: string, rel: string, state: RuleState) => PolicyVerdict | undefined;
  /** The injected OwnedPathsPolicy (S3-2 port); the owned-config refusal reads through it. */
  readonly ownedPaths: OwnedPathsPolicy;
}

/**
 * Does `resolved` (already absolute and symlink-resolved) enter a `.git`
 * directory anywhere along its path relative to `root`?
 *
 * A path-SEGMENT match, never a prefix or substring one: `.gitignore` and
 * `.github/` are ordinary tracked names a tool must still be able to reach,
 * and `startsWith(".git")` would wrongly swallow both -- the exact defect
 * this function exists to avoid (nax#1943).
 *
 * Matches ANY segment, not only a leading one. A nested repository or a
 * submodule checked into the tree (`vendor/some-lib/.git`, which may be a
 * directory or, for a submodule, a file pointing at the real gitdir
 * elsewhere) carries the same integrity and containment risk `.git/` at the
 * root does -- the ruling behind this function is "no path-bearing tool ever
 * addresses git metadata", not "only the top-level repository's".
 */
function entersGitMetadata(root: string, resolved: string): boolean {
  const rel = relative(realOrRaw(root), resolved);
  if (rel === "" || rel.startsWith("..")) return false;
  return rel.split(sep).includes(".git");
}

/**
 * Absolute, symlink-resolved form of `candidate` if it lies inside `root`,
 * is not itself (and does not lie under) `.git/`, and is not refused by the
 * injected OwnedPathsPolicy's `configRefusal` (S3-2 port) -- for nax, one of
 * nax's own config files.
 *
 * The single containment seam. Multi-root support (a future configurable
 * extension) changes this function and nothing else, which is why every tool
 * receives an already-resolved path rather than resolving one itself. The
 * `.git/` exclusion lives here for the same reason: it applies to every
 * path-bearing tool uniformly, reads included, rather than being
 * re-remembered per tool -- which is exactly the failure mode a declaration
 * on `ToolScope` would reintroduce (nax#1943). `.git/` sits INSIDE the root,
 * so containment alone never bars it, and an unconditional ("*") grant --
 * what every non-Exec tool gets under the default `unrestricted` profile --
 * skips glob matching entirely, so nothing downstream of this function would
 * catch it either. The owned-config refusal arrives through the port: nax
 * injects `naxOwnedPathsPolicy`, an embedder that injects nothing gets
 * `EMPTY_OWNED_PATHS_POLICY` and only containment plus `.git/` remain.
 *
 * Pre-single-frame, this seam carried one exception: an `execTouchedPaths` set
 * (Task 10) admitted a workspace install's repo-ROOT manifest/lockfile even
 * though it sat outside the containment root, which was then the story's
 * package dir. The root move made the containment root the repo root, so the
 * manifest is in-root by construction and that carve-out was retired
 * (PR2/Task 13). There is no exception to this seam now.
 */
export function resolveWithin(root: string, candidate: string, owned: OwnedPathsPolicy): string | null {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  if (isInside(root, absolute)) {
    const resolved = realOrRaw(absolute);
    if (entersGitMetadata(root, resolved) || owned.configRefusal(root, resolved) !== undefined) return null;
    return resolved;
  }
  return null;
}

/**
 * The reason text for a path `resolveWithin` refused (fix round 1, Task 10;
 * `.git/` case added for nax#1943).
 *
 * A bare "resolves outside the permitted root" taught the model nothing
 * the last time this shape of denial mattered: in the run that motivated
 * this whole feature, that message is what led an agent to delete a
 * tsconfig entry instead of installing the package it needed. The design's
 * own rule is that a denial returns the reason AND what would have been
 * allowed.
 *
 * A `.git/`-metadata refusal gets its own branch, checked first: unlike
 * every other refusal this function handles, the candidate is genuinely
 * INSIDE the root, so "resolves outside the permitted root" would be
 * actively misleading rather than merely unhelpful.
 *
 * Every other refused path keeps the plain message. The GitCommit-specific
 * manifest/lockfile message and its `isKnownManifestOrLockfileName` table
 * were retired with the `execTouchedPaths` carve-out (PR2/Task 13): that
 * message existed only to explain the carve-out's rule, and post root move
 * a repo-root manifest is inside the root by construction, so there is no
 * distinct rule left to explain.
 *
 * This must never get chattier for ordinary containment denials, and must
 * never reveal repository structure for a path the model never touched.
 *
 * The root itself IS named, deliberately. The rule above -- never reveal
 * repository structure -- is about paths the model never touched; this path is
 * one the model just passed, and telling it where the boundary is is the
 * difference between "adapt" and "work around". The dispatch preamble
 * (src/prompts/sections/agent-scope.ts) states the same boundary only as a
 * package-relative label (`packages/api`), never as an absolute path, so this
 * message is where the agent first sees the absolute containment root -- and
 * naming a path the model itself handed in is the right disclosure.
 */
function outOfRootReason(root: string, candidate: string, owned: OwnedPathsPolicy): string {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  // The owned-config refusal (for nax: nax's own config files) comes from the
  // injected port (S3-2), which supplies the full reason text.
  const configReason = isInside(root, absolute) ? owned.configRefusal(root, realOrRaw(absolute)) : undefined;
  if (configReason !== undefined) return configReason;
  if (isInside(root, absolute) && entersGitMetadata(root, realOrRaw(absolute))) {
    return (
      "targets git metadata under .git/, which every tool is refused regardless of grant -- " +
      "writing there can corrupt the repository beyond git's own recovery, and reading its " +
      "config is a route to influencing what nax executes without passing through Exec (nax#1943)"
    );
  }
  return `resolves outside the permitted root (${root}), which is the only directory this tool can reach`;
}

/**
 * The path globs in a grant, which for a verb-gated tool means the patterns
 * that are not verb names.
 *
 * A grant list is overloaded -- verbs for Git, path globs for Write -- so
 * matching every pattern against a path denied everything for Git, and
 * matching none left its paths bounded by the root alone. `allowedVerbs` is a
 * closed set the tool declares, so the two kinds separate without guessing.
 */
function pathMatchers(matchers: CompiledPattern[], scope: ToolScope): CompiledPattern[] {
  const verbs = scope.allowedVerbs;
  return verbs === undefined ? matchers : matchers.filter((m) => !verbs.includes(m.source));
}

/** Canonical repo-root-relative spelling grant globs and rules are matched against. */
function repoRelative(resolvedRoot: string, resolved: string): string {
  return relative(resolvedRoot, resolved).split(sep).join("/");
}

/**
 * A path spelled with the confined prefix the tool is already bound to
 * (`.nax/scratchpad/spill/x.txt`) has it removed before `resolveWithin`
 * runs, so both spellings reach the same file. This is a prefix REMOVAL,
 * not a second containment root: what is left is still resolved inside
 * the effective root, so a `..` after the prefix remains a breach.
 */
function stripConfinePrefix(confinePrefix: string, value: string): string {
  return confinePrefix !== "" && value.startsWith(confinePrefix) ? value.slice(confinePrefix.length) : value;
}

/** Everything one `pathsBranch` call walks: per-policy collaborators, the call, and the walk's scratch. */
interface PathCheckFrame {
  readonly ctx: PathsBranchContext;
  readonly tool: string;
  readonly scope: ToolScope;
  readonly input: Record<string, unknown>;
  readonly globs: readonly CompiledPattern[];
  /** The containment root for this call: the policy root, or its confined subtree. */
  readonly effectiveRoot: string;
  readonly state: RuleState;
  /** Resolved paths so far, in field order. Mutated in place, never reassigned. */
  readonly resolvedPaths: string[];
  readonly confinePrefix: string;
  /** Glob predicate for string fields: a conditional grant with NO globs still denies. */
  readonly enforcePathGlobs: boolean;
  /** Glob predicate for array/ref fields: needs a conditional grant that carries globs. */
  readonly restrictPaths: boolean;
}

/** One candidate path spelled by the call, in the middle of a field walk. */
interface PathCandidate {
  /** The spelling to confine-strip and resolve. */
  readonly path: string;
  /** Leads the containment-breach reason: `path "x"` or `"refs" entry "HEAD:x"`. */
  readonly denialSubject: string;
  /** The spelling `outOfRootReason` receives — a ref's path half, not the whole ref. */
  readonly outOfRootTarget: string;
}

/**
 * Resolve one candidate inside the effective root, then evaluate
 * deny -> ask -> glob -> record. Returns a verdict to stop the walk with, or
 * undefined when the candidate is admitted and the walk continues.
 * `enforceGlobs` is the CALLER's glob predicate (`enforcePathGlobs` for string
 * fields, `restrictPaths` for array/ref fields — see the module comment).
 */
function checkPathSegment(
  frame: PathCheckFrame,
  candidate: PathCandidate,
  enforceGlobs: boolean,
): PolicyVerdict | undefined {
  const resolved = resolveWithin(
    frame.effectiveRoot,
    stripConfinePrefix(frame.confinePrefix, candidate.path),
    frame.ctx.ownedPaths,
  );
  if (resolved === null) {
    return frame.ctx.deny(
      `${candidate.denialSubject} ${outOfRootReason(frame.effectiveRoot, candidate.outOfRootTarget, frame.ctx.ownedPaths)}`,
      true,
    );
  }
  const rel = repoRelative(frame.ctx.resolvedRoot, resolved);
  const ruleDenial = frame.ctx.applyPathRules(frame.tool, rel, frame.state);
  if (ruleDenial !== undefined) return ruleDenial;
  if (enforceGlobs && !matchesAny(frame.globs, rel)) {
    return frame.ctx.deny(`${frame.tool} is not granted "${rel}" for this stage`);
  }
  frame.resolvedPaths.push(resolved);
  return undefined;
}

/** `scope.pathFields`: each field holds ONE path, checked as a whole. */
function runPathFields(frame: PathCheckFrame): PolicyVerdict | undefined {
  for (const field of frame.scope.pathFields) {
    const value = pathFieldValue(frame.input, field);
    if (value === undefined) continue;
    if (typeof value !== "string") return frame.ctx.deny(`"${field}" must be a string path`);
    const denial = checkPathSegment(
      frame,
      { path: value, denialSubject: `path "${value}"`, outOfRootTarget: value },
      frame.enforcePathGlobs,
    );
    if (denial !== undefined) return denial;
  }
  return undefined;
}

/** `scope.listPathFields`: each field holds a whitespace-separated list, or an array, of paths. */
function runListPathFields(frame: PathCheckFrame): PolicyVerdict | undefined {
  for (const field of frame.scope.listPathFields ?? []) {
    const value = pathFieldValue(frame.input, field);
    if (value === undefined) continue;
    const elements =
      typeof value === "string"
        ? pathListElements(value, frame.effectiveRoot)
        : Array.isArray(value) && value.every((element) => typeof element === "string")
          ? value
          : null;
    if (elements === null) return frame.ctx.deny(`"${field}" must be a string path or an array of string paths`);

    for (const element of elements) {
      const denial = checkPathSegment(
        frame,
        { path: element, denialSubject: `path "${element}"`, outOfRootTarget: element },
        frame.enforcePathGlobs,
      );
      if (denial !== undefined) return denial;
    }
  }
  return undefined;
}

/** `scope.arrayPathFields`: each field holds an array whose every element is a path. */
function runArrayPathFields(frame: PathCheckFrame): PolicyVerdict | undefined {
  for (const field of frame.scope.arrayPathFields ?? []) {
    const values = frame.input[field];
    if (values === undefined) continue;
    if (!Array.isArray(values)) return frame.ctx.deny(`"${field}" must be an array of string paths`);

    for (const value of values) {
      if (typeof value !== "string") return frame.ctx.deny(`"${field}" entries must be strings`);
      const denial = checkPathSegment(
        frame,
        { path: value, denialSubject: `"${field}" entry "${value}"`, outOfRootTarget: value },
        frame.restrictPaths,
      );
      if (denial !== undefined) return denial;
    }
  }
  return undefined;
}

/** `scope.refPathFields`: each field holds an array of refs that MAY carry a `<rev>:<path>` path half. */
function runRefPathFields(frame: PathCheckFrame): PolicyVerdict | undefined {
  for (const field of frame.scope.refPathFields ?? []) {
    const values = frame.input[field];
    if (values === undefined) continue;
    if (!Array.isArray(values)) return frame.ctx.deny(`"${field}" must be an array of string refs`);

    for (const value of values) {
      if (typeof value !== "string") return frame.ctx.deny(`"${field}" entries must be strings`);
      const colonAt = value.indexOf(":");
      if (colonAt === -1) continue; // pure revision, no path to check
      const candidatePath = value.slice(colonAt + 1);
      if (candidatePath === "") continue; // e.g. "HEAD:" — no path to check

      const denial = checkPathSegment(
        frame,
        { path: candidatePath, denialSubject: `"${field}" entry "${value}"`, outOfRootTarget: candidatePath },
        frame.restrictPaths,
      );
      if (denial !== undefined) return denial;
    }
  }
  return undefined;
}

/**
 * Containment runs before any pattern matching and wins over everything.
 * Each resolved path is then evaluated deny -> ask -> allow. A verb-only
 * grant declares no path globs, leaving the root as the only bound --
 * unchanged behaviour, now an authoring choice rather than something the
 * grant syntax could not express.
 *
 * `confineTo` (tool-declared, see `ToolScope`) shifts the root passed to
 * `resolveWithin` from `<root>` to `<root>/<confineTo>`: containment stays
 * the one seam, and only its ROOT changes. `relativeTo` keeps rooting at
 * `resolvedRoot` so grant globs, deny rules and the injected policy's
 * `writeRefusal` continue to see the canonical repo-root-relative spelling -- authors
 * write `.nax/scratchpad/**`, never `**`, regardless of `confineTo`.
 *
 * `confineTo` is bound to stay INSIDE `resolvedRoot`: an authoring typo of
 * `..` or `../shared` would otherwise widen the containment root past the
 * policy boundary and re-scope `resolveWithin`'s `.git/`-metadata and the
 * port's `configRefusal` protections to a root that no longer aligns with the
 * segments those checks assume -- the repo's own `.nax/config.json` would
 stop being segment-matched against `.nax`. The boundary is the policy
 root's invariant, so an out-of-root confineTo refuses the call outright
 rather than silently widening.
 */
export function pathsBranch(args: {
  readonly ctx: PathsBranchContext;
  readonly tool: string;
  readonly scope: ToolScope;
  readonly input: Record<string, unknown>;
  readonly grant: CompiledEntry;
  readonly state: RuleState;
}): PolicyVerdict {
  const { ctx, tool, scope, input, grant, state } = args;
  const globs = pathMatchers(grant.matchers, scope);
  let effectiveRoot = ctx.resolvedRoot;
  if (scope.confineTo !== undefined) {
    effectiveRoot = realOrRaw(join(ctx.resolvedRoot, scope.confineTo));
    if (!isInside(ctx.resolvedRoot, effectiveRoot)) {
      return ctx.deny(
        `${tool} declares confineTo "${scope.confineTo}" which resolves outside the policy root "${ctx.resolvedRoot}" -- confineTo must be a path INSIDE the policy root, never one that widens it`,
      );
    }
  }
  const frame: PathCheckFrame = {
    ctx,
    tool,
    scope,
    input,
    globs,
    effectiveRoot,
    state,
    resolvedPaths: [],
    confinePrefix: scope.confineTo === undefined ? "" : `${scope.confineTo}/`,
    enforcePathGlobs: !grant.unconditional,
    restrictPaths: !grant.unconditional && globs.length > 0,
  };
  const denial =
    runPathFields(frame) ?? runListPathFields(frame) ?? runArrayPathFields(frame) ?? runRefPathFields(frame);
  if (denial !== undefined) return denial;
  return state.ask === undefined
    ? { allowed: true, resolvedPaths: frame.resolvedPaths }
    : ctx.askVerdict(frame.resolvedPaths, state.ask);
}
