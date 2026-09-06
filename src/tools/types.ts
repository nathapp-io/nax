/**
 * Shared vocabulary for nax's own coding tools.
 *
 * Deliberately free of any transport type: this module is imported by the
 * policy, the tools and the runtime, none of which may see `@nathapp/nax-ai`
 * (check:nax-ai-imports confines that package to src/agents/native/).
 */

/**
 * Policy identity for RunCommand's allowlisted, model-authored argv branch,
 * and the marker an operation's `tools` declaration uses to request it.
 * `Exec` is not a registered tool — nothing in `registerBuiltinCodingTools`
 * carries this name, and it is reserved (`RESERVED_TOOL_NAMES`) precisely so
 * no third party can register a tool that shadows the identity.
 */
export const EXEC_TOOL_NAME = "Exec";

/** The tools nax ships. Third parties register additional names at runtime. */
export type CodingToolName =
  | "Read"
  | "Glob"
  | "Grep"
  | "Write"
  | "Edit"
  | "Git"
  | "GitCommit"
  | "RunCommand"
  | "RequestCapability"
  | "Exec";

/**
 * One declarative permission grant, as produced by resolvePermissions.
 *
 * `patterns` is either globs over the tool's path-bearing fields
 * (`["src/**"]`), or the verb list for a verb-gated tool (`["diff","log"]`).
 * `["*"]` means unconditional — but never wider than the root.
 */
export interface ToolGrant {
  readonly tool: string;
  readonly patterns: readonly string[];
}

/**
 * How the policy gates a given tool, declared by the tool itself.
 *
 * Declaring the path-bearing fields is what lets the policy gate a tool it has
 * no special knowledge of, including one registered by a third party. A tool
 * with no path fields is gated at the tool/verb level instead — the honest
 * expression for something whose arguments are not paths.
 *
 * `arrayPathFields` and `refPathFields` extend the same containment seam to
 * array-valued inputs — Git is the only current user.
 *
 * A verb-gated tool's grant list is overloaded: `["diff","log"]` are verbs, so
 * matching them against a path denies everything. The policy separates the two
 * by `allowedVerbs`, a closed set the tool declares — a pattern naming a
 * permitted verb is a verb, anything else is a path glob. So `Git(diff,src/**)`
 * grants the `diff` verb over `src/**`, and `Git(diff)` declares no path glob
 * and is bounded by the root alone.
 */
export interface ToolScope {
  /**
   * String paths in the input. Dot-separated names address nested object
   * properties (for example `values.files` in RunCommand).
   */
  readonly pathFields: readonly string[];
  /** Array-valued fields whose every element is a path. */
  readonly arrayPathFields?: readonly string[];
  /**
   * Array-valued fields whose elements are refs that MAY carry a path after a
   * `:` (git's `<rev>:<path>` syntax). Only the substring after the first `:`
   * is checked for containment; an element with no `:`, or an empty path
   * after it, is a pure revision and is left unchecked.
   */
  readonly refPathFields?: readonly string[];
  readonly verbField?: string;
  readonly allowedVerbs?: readonly string[];
}

/**
 * `breach` separates "you may not write there" from "that path is not in this
 * repository at all". Both deny; only the latter is logged at warn, because a
 * path escaping the root can mean prompt injection.
 */
export type PolicyVerdict =
  | { readonly allowed: true; readonly resolvedPaths: readonly string[] }
  | { readonly allowed: false; readonly reason: string; readonly breach: boolean };

export interface ToolPolicy {
  readonly root: string;
  grantedTools(): readonly string[];
  check(tool: string, scope: ToolScope, input: Record<string, unknown>): PolicyVerdict;
}
