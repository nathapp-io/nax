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

/**
 * Policy identity of the model-authored shell tool.
 *
 * Unlike `Exec`, `Bash` IS a registered tool — but a session-local one
 * (`createBashTool`), because it needs the project's shell and env-strip list.
 * Reserved (`RESERVED_TOOL_NAMES`) so no third party can register a tool that
 * shadows the identity the policy gates.
 */
export const BASH_TOOL_NAME = "Bash";

/** The tools nax ships. Third parties register additional names at runtime. */
export type CodingToolName =
  | "Read"
  | "Glob"
  | "Grep"
  | "Write"
  | "Edit"
  | "Delete"
  | "Git"
  | "GitCommit"
  | "RunCommand"
  | "RequestCapability"
  | "Exec"
  | "Bash";

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
  /**
   * Root-relative subdirectory the tool's path fields are confined to.
   * Containment runs against `<root>/<confineTo>` instead of `<root>`, so a
   * path-bearing tool can never reach the rest of the repository even under
   * an unconditional grant. Grant globs, deny rules and `naxOwnedWriteRefusal`
   * keep seeing the canonical repo-root-relative spelling: containment is the
   * single seam, only its ROOT shifts. Tool-declared, never config-declared --
   * a mis-set `pathFields` grant must not be able to widen the tool's reach.
   */
  readonly confineTo?: string;
  /** Array-valued fields whose every element is a path. */
  readonly arrayPathFields?: readonly string[];
  /**
   * String fields whose value is a whitespace-separated LIST of paths, every
   * element resolved and grant-checked on its own (`splitPathList`).
   *
   * Distinct from `pathFields`, which checks the value as ONE path. That is
   * sound only while the value also REACHES the shell as one argument: a
   * multi-element value like `"a.test.ts ../../etc/passwd"` resolves, as a
   * single path, to a location inside the root, so `pathFields` approves it.
   * Whole-value quoting is what kept that honest -- and whole-value quoting is
   * exactly the defect #1998 fixes. So per-element quoting and per-element
   * checking have to land together: this field is the checking half. Nothing
   * was exploitable before; splitting without it would have made it so.
   */
  readonly listPathFields?: readonly string[];
  /**
   * Array-valued fields whose elements are refs that MAY carry a path after a
   * `:` (git's `<rev>:<path>` syntax). Only the substring after the first `:`
   * is checked for containment; an element with no `:`, or an empty path
   * after it, is a pure revision and is left unchecked.
   */
  readonly refPathFields?: readonly string[];
  readonly verbField?: string;
  readonly allowedVerbs?: readonly string[];
  /**
   * The input field holding a model-authored argv (RunCommand's `Exec`
   * branch). When a call carries this field, the policy checks it under the
   * `Exec` identity (`EXEC_TOOL_NAME`), matching each grant pattern against
   * the argv token-by-token, rather than under the tool's own name — an
   * `Exec(...)` grant is otherwise never consulted and a `RunCommand(*)`
   * wildcard would silently cover the argv branch too.
   */
  readonly argvField?: string;
  /**
   * The input field holding a model-authored shell COMMAND STRING (`Bash`).
   * A call carrying this field is evaluated per shell segment by
   * `src/tools/policy-bash.ts` rather than by the verb or path branches; a
   * tool declaring it must be granted explicitly, since no profile grants one.
   */
  readonly commandField?: string;
}

/**
 * `breach` separates "you may not write there" from "that path is not in this
 * repository at all". Both deny; only the latter is logged at warn, because a
 * path escaping the root can mean prompt injection.
 *
 * `outcome` makes the refusal three-state. "ask" means every OTHER gate passed
 * and an ask rule matched -- an AskResolver may approve it (spec R1). Absent or
 * "denied" is final. The ask shape is still `allowed: false` on purpose: any
 * consumer that only reads `allowed` fails closed. `resolvedPaths` is present
 * only with "ask", describing what an approval would admit.
 */
export type PolicyVerdict =
  | { readonly allowed: true; readonly resolvedPaths: readonly string[] }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly breach: boolean;
      readonly outcome?: "denied" | "ask";
      readonly resolvedPaths?: readonly string[];
      /** Present only with outcome "ask": the matching configured rule expression. */
      readonly rule?: string;
    };

export interface ToolPolicy {
  readonly root: string;
  grantedTools(): readonly string[];
  check(tool: string, scope: ToolScope, input: Record<string, unknown>): PolicyVerdict;
}
