/**
 * Compile declarative grants into a policy, and answer one call at a time.
 *
 * nax-permission-mode-allow: applies grants resolved by resolvePermissions;
 * decides no permission of its own.
 *
 * Containment runs BEFORE pattern matching and is not expressible in config:
 * the root is a boundary no PROFILE can widen. `unrestricted` means "any
 * tool, any path within the root", never "any path on the machine".
 *
 * The one exception is `execTouchedPaths` (Task 10), and it is not a profile
 * widening: see `resolveWithin` below for what it admits and why that is not
 * the same kind of hole.
 */

import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { isInside, realOrRaw } from "@/utils/realpath";
import { validateArgv } from "./exec-guard";
import { isKnownManifestOrLockfileName } from "./exec-touched-paths";
import { pathListElements } from "./path-list";
import { checkBashCommand } from "./policy-bash";
import {
  type CompiledEntry,
  type CompiledPattern,
  compileArgvPattern,
  compileRuleMap,
  globToRegExp,
  matchedArgvSource,
  matchedGlobSource,
  matchedRulePatterns,
  matchesAny,
  matchesArgvGrant,
} from "./policy-match";
import type { PolicyVerdict, ToolGrant, ToolPolicy, ToolScope } from "./types";

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
 * Absolute, symlink-resolved form of `candidate` if it lies inside `root`
 * and is not itself, or does not lie under, `.git/`.
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
 * catch it either.
 *
 * The one exception to the paragraph above, and it is not a profile widening:
 * a workspace package manager writes the root manifest and lockfile by design,
 * so an Exec that nax itself normalized and ran records those two paths in
 * `execTouchedPaths` (see `src/tools/run-command-exec.ts` and
 * `src/tools/exec-touched-paths.ts`). Nothing else is admitted, matching is
 * exact (never a prefix — a single touched path must never widen a whole
 * directory), and the set is session-scoped: it is built fresh for one
 * dispatch hop and shared only between that hop's Exec and GitCommit calls,
 * never persisted across stories or sessions. That carve-out needs no `.git/`
 * check of its own, and adding one would be dead code rather than defence in
 * depth: it is reached only when `isInside` is false, and `isInside` resolves
 * symlinks on BOTH sides (`src/utils/realpath.ts`), so any candidate whose
 * real path lands under `.git/` -- however it is spelled, symlink included --
 * is already refused by the branch above. A path that reaches the carve-out
 * has a real path outside the root, and `entersGitMetadata` reports false for
 * every such path by construction.
 */
export function resolveWithin(root: string, candidate: string, execTouchedPaths?: readonly string[]): string | null {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  if (isInside(root, absolute)) {
    const resolved = realOrRaw(absolute);
    return entersGitMetadata(root, resolved) ? null : resolved;
  }
  const resolved = realOrRaw(absolute);
  if (execTouchedPaths?.some((touched) => realOrRaw(touched) === resolved)) return resolved;
  return null;
}

/** Mutable scratch shared by `check()`'s branch helpers: first ask rule matched. */
interface RuleState {
  ask?: string;
}

/** Read a top-level or dot-addressed path-bearing input field. */
function pathFieldValue(input: Record<string, unknown>, field: string): unknown {
  let value: unknown = input;
  for (const part of field.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export interface ToolPolicyOptions {
  /**
   * Paths a prior, successfully-run allowlisted Exec call touched — the
   * containment carve-out documented on `resolveWithin`. Read live, not
   * copied: callers that build this once per dispatch hop and keep pushing
   * into the same array (`src/agents/coding-tool-support.ts`) get updates
   * reflected on every subsequent `check()` without recompiling the policy.
   */
  readonly execTouchedPaths?: readonly string[];
  /**
   * Stage deny rules (spec R6). Same {tool, patterns} shape as grants; matched
   * per branch and evaluated BEFORE ask and allow. A tool's unconditional
   * deny rule also de-advertises it (see `grantedTools`).
   */
  readonly denyRules?: readonly ToolGrant[];
  /**
   * Stage ask rules (spec R1/R6). An ask match does not grant or refuse on its
   * own: it marks a call the stage already granted as needing approval. An ask
   * on an ungranted call is a plain denial.
   */
  readonly askRules?: readonly ToolGrant[];
}

function isFieldlessScope(scope: ToolScope): boolean {
  return (
    scope.argvField === undefined &&
    scope.commandField === undefined &&
    scope.verbField === undefined &&
    scope.pathFields.length === 0 &&
    (scope.listPathFields?.length ?? 0) === 0 &&
    (scope.arrayPathFields?.length ?? 0) === 0 &&
    (scope.refPathFields?.length ?? 0) === 0
  );
}

export function compileToolPolicy(grants: readonly ToolGrant[], root: string, options?: ToolPolicyOptions): ToolPolicy {
  const resolvedRoot = realOrRaw(root);
  const execTouchedPaths = options?.execTouchedPaths;
  const denyBy = compileRuleMap(options?.denyRules);
  const askBy = compileRuleMap(options?.askRules);
  const compiled = new Map<
    string,
    {
      unconditional: boolean;
      matchers: CompiledPattern[];
      argvPatterns: readonly (readonly CompiledPattern[])[];
      raw: readonly string[];
    }
  >();

  for (const grant of grants) {
    const unconditional = grant.patterns.includes("*");
    const nonWildcard = grant.patterns.filter((p) => p !== "*");
    compiled.set(grant.tool, {
      unconditional,
      matchers: nonWildcard.map((source) => ({ source, re: globToRegExp(source) })),
      argvPatterns: nonWildcard.map((source) => compileArgvPattern(source)),
      raw: grant.patterns,
    });
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

  function deny(reason: string, breach = false): PolicyVerdict {
    return { allowed: false, reason, breach, outcome: "denied" };
  }

  /**
   * `allowed: false` on purpose: any consumer that only reads `allowed` fails
   * closed. `outcome: "ask"` is the sole signal that an AskResolver may approve
   * this call, and `resolvedPaths` is what an approval would admit.
   */
  function askVerdict(resolvedPaths: readonly string[], rule: string): PolicyVerdict {
    return {
      allowed: false,
      reason: `matched ask rule "${rule}" — requires approval before it may run`,
      breach: false,
      outcome: "ask",
      resolvedPaths,
      rule,
    };
  }

  /** `Tool` for an unconditional entry, else `Tool(pattern, ...)`. */
  function ruleExpr(tool: string, entry: CompiledEntry, source?: string): string {
    const patterns = source === undefined ? entry.raw : matchedRulePatterns(entry, source);
    return patterns.includes("*") ? tool : `${tool}(${patterns.join(", ")})`;
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
   * For GitCommit specifically, when the refused path is not `.git/`-shaped
   * but LOOKS like a manifest or lockfile (`isKnownManifestOrLockfileName`,
   * the same closed table `recordExecTouchedPaths` writes from), the message
   * explains the actual rule: only a manifest/lockfile an Exec call touched
   * IN THIS TURN can be staged from outside the story's own package root, and
   * even when that is not this call, the run's completion-phase auto-commit
   * sweep (`autoCommitIfDirty`, `src/utils/git.ts`) stages root-level changes
   * regardless, so the work is not silently lost.
   *
   * Every other refused path — including a manifest-shaped path for a tool
   * OTHER than GitCommit, and any non-manifest-shaped path at all — keeps the
   * plain message. This must never get chattier for ordinary containment
   * denials, and must never reveal repository structure for a path the model
   * never touched.
   */
  function outOfRootReason(tool: string, root: string, candidate: string): string {
    const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
    if (isInside(root, absolute) && entersGitMetadata(root, realOrRaw(absolute))) {
      return (
        "targets git metadata under .git/, which every tool is refused regardless of grant -- " +
        "writing there can corrupt the repository beyond git's own recovery, and reading its " +
        "config is a route to influencing what nax executes without passing through Exec (nax#1943)"
      );
    }
    if (tool === "GitCommit") {
      if (isKnownManifestOrLockfileName(basename(absolute))) {
        return (
          "lies outside this story's package root; only a manifest or lockfile touched by an " +
          'Exec install in THIS turn can be staged from here (see Exec\'s `target: "repoRoot"` ' +
          "form), and this call's containment carve-out does not cover it -- the run's " +
          "completion-phase auto-commit sweep stages root-level changes regardless, so the " +
          "work is not lost even if this commit is refused"
        );
      }
    }
    return "resolves outside the permitted root";
  }

  /**
   * Deny (spec R6) outranks ask, and both are evaluated per resolved path.
   * Returns a denial verdict when a deny glob matches; otherwise records the
   * matching ask source on `state` and returns undefined. Ask never grants on
   * its own: the caller's allow checks still run, so an ungranted path stays
   * denied and an ask on an ungranted call never becomes an approval prompt.
   */
  function applyPathRules(tool: string, rel: string, state: RuleState): PolicyVerdict | undefined {
    const denyEntry = denyBy.get(tool);
    const askEntry = askBy.get(tool);
    if (denyEntry !== undefined && (denyEntry.unconditional || matchesAny(denyEntry.matchers, rel))) {
      return deny(`${tool} path "${rel}" is denied for this stage`);
    }
    if (askEntry !== undefined && (askEntry.unconditional || matchesAny(askEntry.matchers, rel))) {
      state.ask = ruleExpr(tool, askEntry, askEntry.unconditional ? "*" : matchedGlobSource(askEntry.matchers, rel));
    }
    return undefined;
  }

  /**
   * RunCommand's `Exec` branch, checked entirely here and never falling through
   * to verbField/pathFields: there is no "command" field on this shape for
   * verbField to read. `validateArgv` runs FIRST -- before this grant's patterns
   * are even consulted -- so a malformed token can never be admitted by a `*`
   * grant that would otherwise wave anything through unchecked. Returns
   * undefined when this is not an argv call, so the caller tries the next branch.
   */
  function argvBranch(
    tool: string,
    scope: ToolScope,
    input: Record<string, unknown>,
    grant: CompiledEntry,
  ): PolicyVerdict | undefined {
    if (scope.argvField === undefined) return undefined;
    const rawArgv = input[scope.argvField];
    if (rawArgv === undefined) return undefined;
    const invalid = validateArgv(rawArgv);
    if (invalid !== undefined) return deny(invalid);
    const argv = rawArgv as readonly string[];

    const denyEntry = denyBy.get(tool);
    if (denyEntry !== undefined && (denyEntry.unconditional || matchesArgvGrant(denyEntry.argvPatterns, argv))) {
      return deny(`${tool} is denied for argv "${argv.join(" ")}" for this stage`);
    }
    if (!grant.unconditional && !matchesArgvGrant(grant.argvPatterns, argv)) {
      // Name the granted forms, not just the refusal. A bare "no" is what
      // produced the defect this branch exists to fix: denied with no legal
      // alternative named, the model deleted the requirement instead of
      // installing it. An unconditional grant never enters this branch (see
      // the guard above), so `raw` cannot contain the bare "*" element --
      // entries *containing* "*" (`bun add*`) are exactly what we want to name.
      const granted = grant.raw.join(", ");
      const alternatives = granted === "" ? "no argv forms are granted for this stage" : `granted forms: ${granted}`;
      return deny(`${tool} is not granted for argv "${argv.join(" ")}" -- ${alternatives}`);
    }
    const askEntry = askBy.get(tool);
    if (askEntry !== undefined && (askEntry.unconditional || matchesArgvGrant(askEntry.argvPatterns, argv))) {
      return askVerdict([], ruleExpr(tool, askEntry, askEntry.unconditional ? "*" : matchedArgvSource(askEntry, argv)));
    }
    return { allowed: true, resolvedPaths: [] };
  }

  /**
   * The Bash branch. Checked entirely in policy-bash.ts and never falling
   * through: a command string is not a verb and not a path, so neither of the
   * other branches can judge it. Containment is handed over as a callback
   * because policy-bash.ts may not import this module back.
   */
  function commandBranch(
    tool: string,
    scope: ToolScope,
    input: Record<string, unknown>,
    grant: CompiledEntry,
  ): PolicyVerdict | undefined {
    if (scope.commandField === undefined) return undefined;
    const denyEntry = denyBy.get(tool);
    const askEntry = askBy.get(tool);
    const result = checkBashCommand({
      tool,
      command: input[scope.commandField],
      grant,
      ...(denyEntry !== undefined ? { denyEntry } : {}),
      ...(askEntry !== undefined ? { askEntry } : {}),
      resolvePath: (candidate) => resolveWithin(resolvedRoot, candidate, execTouchedPaths),
    });
    if (result.kind === "deny") return deny(result.reason, result.breach);
    if (result.kind === "ask") return askVerdict([], result.rule);
    return { allowed: true, resolvedPaths: [] };
  }

  /**
   * Verb gating: the tool's own allowedVerbs bound what config can grant, so a
   * "*" grant can never reach a mutating subcommand. A deny/ask rule names a
   * verb directly here -- unlike the allow path (`pathMatchers`), these are not
   * filtered through `allowedVerbs`, so a deny for a verb the tool does not even
   * allow still reads as the rule's denial, not a generic "not a permitted
   * subcommand". Returns undefined once the gate passes (or is absent), so the
   * caller can check paths next.
   */
  function verbBranch(
    tool: string,
    scope: ToolScope,
    input: Record<string, unknown>,
    grant: CompiledEntry,
    state: RuleState,
  ): PolicyVerdict | undefined {
    if (scope.verbField === undefined) return undefined;
    const verb = input[scope.verbField];
    if (typeof verb !== "string") return deny(`"${scope.verbField}" must be a string`);

    const denyEntry = denyBy.get(tool);
    if (denyEntry !== undefined && (denyEntry.unconditional || denyEntry.raw.includes(verb))) {
      return deny(`${tool} is denied the "${verb}" subcommand for this stage`);
    }

    // Name what the stage can actually use, not merely what the tool allows
    // (nax#1971). `allowedVerbs` alone would advertise a verb a narrower grant
    // refuses one line below -- sending the model straight back into a denial,
    // which is the defect #1937 exists to fix.
    const usableVerbs =
      scope.allowedVerbs === undefined
        ? []
        : grant.unconditional
          ? [...scope.allowedVerbs]
          : scope.allowedVerbs.filter((v) => grant.raw.includes(v));
    const permitted =
      usableVerbs.length === 0 ? "no subcommands are permitted for this stage" : `permitted: ${usableVerbs.join(", ")}`;

    if (scope.allowedVerbs !== undefined && !scope.allowedVerbs.includes(verb)) {
      return deny(`"${verb}" is not a permitted ${tool} subcommand -- ${permitted}`);
    }
    if (!grant.unconditional && !grant.raw.includes(verb)) {
      return deny(`${tool} is not granted the "${verb}" subcommand for this stage -- ${permitted}`);
    }

    const askEntry = askBy.get(tool);
    if (askEntry !== undefined && (askEntry.unconditional || askEntry.raw.includes(verb))) {
      state.ask = ruleExpr(tool, askEntry, askEntry.unconditional ? "*" : verb);
    }
    return undefined;
  }

  /**
   * Containment runs before any pattern matching and wins over everything.
   * Each resolved path is then evaluated deny -> ask -> allow. A verb-only
   * grant declares no path globs, leaving the root as the only bound --
   * unchanged behaviour, now an authoring choice rather than something the
   * grant syntax could not express.
   */
  function pathsBranch(
    tool: string,
    scope: ToolScope,
    input: Record<string, unknown>,
    grant: CompiledEntry,
    state: RuleState,
  ): PolicyVerdict {
    const globs = pathMatchers(grant.matchers, scope);
    const relativeTo = (resolved: string) => relative(resolvedRoot, resolved).split(sep).join("/");
    const restrictPaths = !grant.unconditional && globs.length > 0;
    const resolvedPaths: string[] = [];

    for (const field of scope.pathFields) {
      const value = pathFieldValue(input, field);
      if (value === undefined) continue;
      if (typeof value !== "string") return deny(`"${field}" must be a string path`);

      const resolved = resolveWithin(resolvedRoot, value, execTouchedPaths);
      if (resolved === null) {
        return deny(`path "${value}" ${outOfRootReason(tool, resolvedRoot, value)}`, true);
      }

      const rel = relativeTo(resolved);
      const ruleDenial = applyPathRules(tool, rel, state);
      if (ruleDenial !== undefined) return ruleDenial;
      if (!grant.unconditional && !matchesAny(globs, rel)) {
        return deny(`${tool} is not granted "${rel}" for this stage`);
      }
      resolvedPaths.push(resolved);
    }

    for (const field of scope.listPathFields ?? []) {
      const value = pathFieldValue(input, field);
      if (value === undefined) continue;
      if (typeof value !== "string") return deny(`"${field}" must be a string path`);

      for (const element of pathListElements(value, resolvedRoot)) {
        const resolved = resolveWithin(resolvedRoot, element, execTouchedPaths);
        if (resolved === null) {
          return deny(`path "${element}" ${outOfRootReason(tool, resolvedRoot, element)}`, true);
        }
        const rel = relativeTo(resolved);
        const ruleDenial = applyPathRules(tool, rel, state);
        if (ruleDenial !== undefined) return ruleDenial;
        if (!grant.unconditional && !matchesAny(globs, rel)) {
          return deny(`${tool} is not granted "${rel}" for this stage`);
        }
        resolvedPaths.push(resolved);
      }
    }

    for (const field of scope.arrayPathFields ?? []) {
      const values = input[field];
      if (values === undefined) continue;
      if (!Array.isArray(values)) return deny(`"${field}" must be an array of string paths`);

      for (const value of values) {
        if (typeof value !== "string") return deny(`"${field}" entries must be strings`);
        const resolved = resolveWithin(resolvedRoot, value, execTouchedPaths);
        if (resolved === null) {
          return deny(`"${field}" entry "${value}" ${outOfRootReason(tool, resolvedRoot, value)}`, true);
        }
        const rel = relativeTo(resolved);
        const ruleDenial = applyPathRules(tool, rel, state);
        if (ruleDenial !== undefined) return ruleDenial;
        if (restrictPaths && !matchesAny(globs, rel)) {
          return deny(`${tool} is not granted "${rel}" for this stage`);
        }
        resolvedPaths.push(resolved);
      }
    }

    for (const field of scope.refPathFields ?? []) {
      const values = input[field];
      if (values === undefined) continue;
      if (!Array.isArray(values)) return deny(`"${field}" must be an array of string refs`);

      for (const value of values) {
        if (typeof value !== "string") return deny(`"${field}" entries must be strings`);
        const colonAt = value.indexOf(":");
        if (colonAt === -1) continue; // pure revision, no path to check
        const candidatePath = value.slice(colonAt + 1);
        if (candidatePath === "") continue; // e.g. "HEAD:" — no path to check

        const resolved = resolveWithin(resolvedRoot, candidatePath, execTouchedPaths);
        if (resolved === null) {
          return deny(`"${field}" entry "${value}" ${outOfRootReason(tool, resolvedRoot, candidatePath)}`, true);
        }
        const rel = relativeTo(resolved);
        const ruleDenial = applyPathRules(tool, rel, state);
        if (ruleDenial !== undefined) return ruleDenial;
        if (restrictPaths && !matchesAny(globs, rel)) {
          return deny(`${tool} is not granted "${rel}" for this stage`);
        }
        resolvedPaths.push(resolved);
      }
    }

    return state.ask === undefined ? { allowed: true, resolvedPaths } : askVerdict(resolvedPaths, state.ask);
  }

  return {
    root: resolvedRoot,

    grantedTools() {
      // A tool with an UNCONDITIONAL deny never reaches a caller; a scoped
      // (pattern) deny leaves it advertised, because some calls still pass.
      return [...compiled.keys()].filter((t) => denyBy.get(t)?.unconditional !== true);
    },

    check(tool, scope, input) {
      const grant = compiled.get(tool);
      if (grant === undefined) return deny(`tool "${tool}" is not permitted for this stage`);

      // Unconditional deny is final and outranks every other gate.
      const denyEntry = denyBy.get(tool);
      if (denyEntry?.unconditional === true) {
        return deny(`tool "${tool}" is denied for this stage by rule ${ruleExpr(tool, denyEntry)}`);
      }

      const askEntry = askBy.get(tool);
      if (askEntry?.unconditional === true && isFieldlessScope(scope)) {
        return askVerdict([], ruleExpr(tool, askEntry));
      }

      const state: RuleState = {};
      return (
        commandBranch(tool, scope, input, grant) ??
        argvBranch(tool, scope, input, grant) ??
        verbBranch(tool, scope, input, grant, state) ??
        pathsBranch(tool, scope, input, grant, state)
      );
    },
  };
}
