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
 * The `execTouchedPaths` carve-out (Task 10) was retired in the single-frame
 * root move (PR2/Task 13): the containment root became the repo root, so a
 * workspace install's root manifest is in-root by construction and no
 * exception to the boundary is needed.
 */

import { relative, resolve, sep } from "node:path";
import type { BashApprovalMode } from "#src/config/bash-approval";
import { realOrRaw } from "#src/internal/realpath";
import { validateArgv } from "./exec-guard.ts";
import { EMPTY_OWNED_PATHS_POLICY, type OwnedPathsPolicy } from "./owned-paths.ts";
import { commandBranch } from "./policy-command-branch.ts";
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
} from "./policy-match.ts";
import { type PathsBranchContext, pathsBranch, type RuleState, resolveWithin } from "./policy-paths-branch.ts";
import { EXEC_TOOL_NAME, type PolicyVerdict, type ToolGrant, type ToolPolicy, type ToolScope } from "./types.ts";
import { argvShellHint } from "./verb-denial-argv-hint.ts";

/** The single containment seam now lives beside the path branch that drives it. */
export { resolveWithin };

export interface ToolPolicyOptions {
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
  /**
   * The ONE nax-owned path this session may write despite the port's
   * `writeRefusal` (nax#2115): the ABSOLUTE `fileOutput` path the dispatching op
   * declared. It is canonicalised into this policy's own root-relative frame below
   * rather than by the caller, so alternate spellings of the same file cannot
   * diverge from the string the guard compares. Only the feature-PRD refusal
   * honours it; the owned CONFIG refusal is deliberately not exempted.
   */
  readonly ownedWriteExemption?: string;
  /** nax#2260: `execution.sandbox.filesystem.allowWrite`; a listed top-level `.nax/` entry becomes writable through the port's `writeOptIns`. */
  readonly naxAllowWrite?: readonly string[];
  /** S3-2: host-owned path rules (OwnedPathsPolicy port). Absent: none, the embedder default. */
  readonly ownedPaths?: OwnedPathsPolicy;
  /**
   * How a bash command string is adjudicated (ADR-030). Absent means `gated` —
   * today's behaviour — so every caller that does not opt in is unchanged.
   *
   * `raw` is a COMPILE-TIME input rather than a post-check transform on
   * purpose: `checkBashCommand` lexes before it evaluates grants, so a `Bash(*)`
   * grant cannot produce pass-through, and a post-check deny→allow would widen
   * genuine containment denials too.
   */
  readonly bashApproval?: BashApprovalMode;
  /**
   * P4: set when `execution.sandbox.enabled` is true and the probe found the
   * sandbox unavailable. Under `raw`, every Bash call is then denied with this
   * reason -- raw requires the sandbox once it is enabled, and a silent
   * fallback to unsandboxed raw would be a posture downgrade (spec S5).
   * Ignored under gated/escalate, which run unwrapped with a warning.
   */
  readonly rawBashRefusal?: string;
  readonly sandboxWrapped?: boolean; // US-002: sandbox-wrapped `raw` allows a PRD the command only NAMES.
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
  const owned = options?.ownedPaths ?? EMPTY_OWNED_PATHS_POLICY;
  // nax#2115: the SAME transform `relativeTo` applies to every checked path, so
  // the guard compares like with like. A path outside the root yields a
  // ".."-prefixed rel that can never equal a checked path's, exempting nothing.
  const ownedWriteExemption =
    options?.ownedWriteExemption === undefined
      ? undefined
      : relative(resolvedRoot, realOrRaw(options.ownedWriteExemption)).split(sep).join("/");
  const naxOptIns = owned.writeOptIns(root, options?.naxAllowWrite ?? []);
  const denyBy = compileRuleMap(options?.denyRules);
  const askBy = compileRuleMap(options?.askRules);
  const bashApproval: BashApprovalMode = options?.bashApproval ?? "gated";
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

  function deny(reason: string, breach = false, escalatable = false): PolicyVerdict {
    return { allowed: false, reason, breach, escalatable, outcome: "denied" };
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
   * Deny (spec R6) outranks ask, and both are evaluated per resolved path.
   * Returns a denial verdict when a deny glob matches; otherwise records the
   * matching ask source on `state` and returns undefined. Ask never grants on
   * its own: the caller's allow checks still run, so an ungranted path stays
   * denied and an ask on an ungranted call never becomes an approval prompt.
   */
  function applyPathRules(tool: string, rel: string, state: RuleState): PolicyVerdict | undefined {
    const naxOwned = owned.writeRefusal(tool, rel, { exemptRel: ownedWriteExemption, optIns: naxOptIns });
    if (naxOwned !== undefined) return deny(`${tool} may not modify ${naxOwned}`);
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

    // See verb-denial-argv-hint.ts (run-2026-09-14T05-55-54-734Z, Shape B).
    const argvHint = argvShellHint(scope.verbField, scope.argvField, compiled.get(EXEC_TOOL_NAME)?.raw ?? []);

    if (scope.allowedVerbs !== undefined && !scope.allowedVerbs.includes(verb)) {
      return deny(`"${verb}" is not a permitted ${tool} subcommand -- ${permitted}${argvHint}`);
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
   * The path branch's collaborators, by reference (see `PathsBranchContext`):
   * the nested helpers below stay authoritative, and the sibling reads them at
   * call time — `pathsBranch` itself lives in `./policy-paths-branch`.
   */
  const pathsBranchContext: PathsBranchContext = { resolvedRoot, deny, askVerdict, applyPathRules, ownedPaths: owned };

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
        commandBranch({
          tool,
          scope,
          input,
          grant,
          bashApproval,
          rawBashRefusal: options?.rawBashRefusal,
          sandboxWrapped: options?.sandboxWrapped,
          ownedPaths: owned,
          resolvedRoot,
          denyBy,
          askBy,
          resolvePath: (candidate, cwd) => resolveWithin(resolvedRoot, resolve(cwd, candidate), owned),
          deny,
          askVerdict,
        }) ??
        argvBranch(tool, scope, input, grant) ??
        verbBranch(tool, scope, input, grant, state) ??
        pathsBranch({ ctx: pathsBranchContext, tool, scope, input, grant, state })
      );
    },
  };
}
