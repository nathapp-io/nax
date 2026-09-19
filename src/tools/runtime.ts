/**
 * Pairs the compiled policy with the tool registry and answers one call.
 *
 * nax-permission-mode-allow: consumes grants resolved by resolvePermissions;
 * makes no permission decision of its own.
 *
 * The three outcomes are kept structurally distinct. Reusing one channel for a
 * refusal and a crash would make a denied permission look like a recoverable
 * tool error, which ADR-029 section 5 forbids.
 */

import { getSafeLogger } from "@/logger";
import { ASK_UNAVAILABLE_REASON, type AskResolver, headlessAskResolver } from "@/permissions";
import { errorMessage } from "@/utils/errors";
import { deleteTool } from "./delete";
import { redirectForArgv, redirectForCommand, redirectForVerb } from "./denial-redirect";
import { editTool } from "./edit";
import { gitTool } from "./git";
import { gitCommitTool } from "./git-commit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { type CodingTool, getCodingTool, registerBuiltinTool } from "./registry";
import { requestCapabilityTool } from "./request-capability";
import { scratchpadListTool, scratchpadReadTool, scratchpadWriteTool } from "./scratchpad";
import { createNoOpToolAuditSink, type ToolAuditSink } from "./tool-audit";
import { EXEC_TOOL_NAME, type ToolPolicy, type ToolScope } from "./types";
import { writeTool } from "./write";

/** Per-call output ceiling, mirroring ToolDescriptor.maxTokensPerCall in spirit. */
export const DEFAULT_TOOL_MAX_BYTES = 40_000;

/** Ceiling for the one-line call description an AskResolver receives. */
const MAX_ASK_SUMMARY_CHARS = 200;

/**
 * Largest file a tool will read whole or write at all.
 *
 * Distinct from DEFAULT_TOOL_MAX_BYTES because they answer different questions:
 * that one is how much the model may be told, this one is how much file a tool
 * will handle. Edit must read and rewrite a file entirely, so it cannot use the
 * output ceiling without refusing ordinary source files.
 *
 * Generous on purpose. Nothing an LLM legitimately edits approaches it, and a
 * limit that fires during normal work would be worked around rather than
 * respected.
 */
export const DEFAULT_TOOL_MAX_FILE_BYTES = 2_000_000;

export type CodingToolOutcome =
  | { readonly kind: "ok"; readonly content: string }
  | { readonly kind: "error"; readonly content: string }
  | { readonly kind: "denied"; readonly reason: string; readonly breach: boolean };

/** Injectable logger seam, mirroring _pullToolsDeps.getLogger. */
export const _codingToolDeps = { getLogger: getSafeLogger };

export interface CodingToolRuntime {
  /** Op declaration intersected with policy grants. Both can only narrow. */
  advertised(declared: readonly string[]): readonly CodingTool[];
  callTool(name: string, input: Record<string, unknown>): Promise<CodingToolOutcome>;
}

let builtinsRegistered = false;

/** Idempotent: the registry is process-global, the runtime is per-session. */
export function registerBuiltinCodingTools(): void {
  if (builtinsRegistered) return;
  for (const tool of [
    readTool,
    globTool,
    grepTool,
    writeTool,
    editTool,
    deleteTool,
    gitTool,
    gitCommitTool,
    requestCapabilityTool,
    scratchpadWriteTool,
    scratchpadReadTool,
    scratchpadListTool,
  ]) {
    if (getCodingTool(tool.name) === undefined) registerBuiltinTool(tool);
  }
  builtinsRegistered = true;
}

/** @internal Test-only: pairs with _resetRegistryForTest. */
export function _resetBuiltinsForTest(): void {
  builtinsRegistered = false;
}

/**
 * One human-readable line describing the call an `ask` rule matched.
 *
 * Built from the scope's DECLARED fields rather than from `JSON.stringify` of
 * the whole input: the input carries a tool's full payload -- file contents on
 * a Write, a commit message, whatever a provider tool takes -- and an
 * AskResolver is by definition an outbound channel to a human. A summary is
 * what approval needs; the payload is what the audit sink already holds.
 */
function askSummary(tool: string, scope: ToolScope, input: Record<string, unknown>): string {
  const fields = [scope.commandField, scope.argvField, scope.verbField, ...scope.pathFields];
  const parts: string[] = [];
  for (const field of fields) {
    if (field === undefined) continue;
    const value = input[field];
    if (typeof value === "string") parts.push(`${field}=${value}`);
    else if (Array.isArray(value)) parts.push(`${field}=${value.filter((v) => typeof v === "string").join(" ")}`);
  }
  return `${tool} ${parts.join(" ")}`.trim().slice(0, MAX_ASK_SUMMARY_CHARS);
}

export function createCodingToolRuntime(opts: {
  policy: ToolPolicy;
  maxBytes?: number;
  maxFileBytes?: number;
  storyId?: string;
  sink?: ToolAuditSink;
  extraTools?: readonly CodingTool[];
  /**
   * Advertised provider tool name -> owning provider id. Lets the ledger carry
   * the provider explicitly instead of splitting the namespaced name apart.
   */
  providerIdByTool?: ReadonlyMap<string, string>;
  /** Declared command names, so a denial can name `testScoped` only when the project has one. */
  declaredCommands?: ReadonlySet<string>;
  /**
   * Repo-configurable glob denylist (nax#1972, `execution.denyPaths`),
   * forwarded verbatim into every ToolRunContext this runtime builds. See
   * src/tools/deny-paths.ts for the matching semantics; today only Delete
   * consults it.
   */
  denyPaths?: readonly string[];
  /**
   * Answers an `ask` verdict (spec R1/R6). Defaults to the headless resolver,
   * which always denies: an unattended run has no human to approve. A runtime
   * capability, not config — injected where the runtime is created.
   */
  askResolver?: AskResolver;
  /**
   * PipelineStage this runtime serves, carried verbatim into every
   * `AskRequest`. A resolver decides on the stage as much as on the tool --
   * "yes during rectification, no during review" is the first policy anyone
   * writes -- so it is threaded in rather than defaulted at the call site.
   */
  pipelineStage?: string;
}): CodingToolRuntime {
  registerBuiltinCodingTools();
  // The global registry cannot hold session-local tools like RunCommand (its
  // declared commands are per-project). Consult this layer before the registry.
  const extra = new Map((opts.extraTools ?? []).map((t) => [t.name, t]));
  const lookup = (name: string): CodingTool | undefined => extra.get(name) ?? getCodingTool(name);
  const sink = opts.sink ?? createNoOpToolAuditSink();
  const maxBytes = opts.maxBytes ?? DEFAULT_TOOL_MAX_BYTES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_TOOL_MAX_FILE_BYTES;
  const askResolver = opts.askResolver ?? headlessAskResolver();
  const granted = new Set(opts.policy.grantedTools());

  // What `advertised()` actually returned, so a denial can name only tools the
  // session really received. Recomputing from `granted` would be wrong: an op
  // narrows the set by declaring fewer tools than it was granted.
  let advertisedNames: ReadonlySet<string> = new Set();

  /**
   * One line per call, mirroring the pull-tool subsystem's `invoked` record.
   *
   * Every outcome is logged, denials included: a refused call that leaves no
   * trace is indistinguishable from a call never made, and telling those two
   * apart is the whole reason this exists.
   *
   * The logger keeps its calls for operator visibility. The audit sink is the
   * durable copy a later decision reads from; the two are not interchangeable.
   */
  function log(
    tool: string,
    outcome: CodingToolOutcome["kind"] | "denied:ask",
    resultBytes: number,
    input: Record<string, unknown>,
    breach?: boolean,
    reason?: string,
    routineErrors?: boolean,
    audit?: { executed?: readonly string[]; target?: "package" | "repoRoot" },
    resultBytesPreTruncation?: number,
  ): void {
    // The level is the console filter: `normal` mode drops debug, and the file
    // sink writes every level regardless, so demoting keeps the record without
    // spending an operator's attention on it. A breach is the one outcome that
    // can indicate prompt injection, so it alone reaches `error`.
    const level =
      outcome === "denied" || outcome === "denied:ask"
        ? breach === true
          ? "error"
          : "warn"
        : outcome === "error" && !routineErrors
          ? "warn"
          : "debug";

    // Never parse the namespaced name apart — the provider id is carried
    // explicitly precisely so a naming-convention change cannot break
    // telemetry silently. `tool` is the identity the ledger records: the
    // namespaced name for a provider tool, `Exec` for the argv branch (which
    // is not provider-supplied, so the lookup misses and the field is absent).
    const provider = opts.providerIdByTool?.get(tool);

    // `reason` rides under the `error` key because the formatter's
    // readFailureReason() renders exactly that key on warn/error lines. The
    // message names the tool so the line is legible without the JSONL: these
    // used to print as a bare "coding-tool invoked" with neither.
    _codingToolDeps.getLogger()?.[level]("coding-tool", `${tool} ${outcome}`, {
      storyId: opts.storyId,
      tool,
      outcome,
      resultBytes,
      ...(reason !== undefined && reason.length > 0 ? { error: reason } : {}),
    });
    sink.record({
      tool,
      outcome,
      breach,
      input,
      resultBytes,
      storyId: opts.storyId,
      at: new Date().toISOString(),
      ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
      ...(audit?.executed !== undefined ? { executed: audit.executed } : {}),
      ...(audit?.target !== undefined ? { target: audit.target } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(resultBytesPreTruncation !== undefined ? { resultBytesPreTruncation } : {}),
    });
  }

  return {
    advertised(declared) {
      const out: CodingTool[] = [];
      for (const name of declared) {
        if (!granted.has(name)) continue;
        const tool = lookup(name);
        if (tool !== undefined) out.push(tool);
      }
      advertisedNames = new Set(out.map((t) => t.name));
      return out;
    },

    async callTool(name, input) {
      const tool = lookup(name);
      if (tool === undefined) {
        const reason = `unknown tool "${name}"`;
        log(name, "denied", 0, input, false, reason);
        return { kind: "denied", reason, breach: false };
      }

      // A call carrying the tool's declared argv field (RunCommand's `Exec`
      // branch) is checked, and ledgered, under the `Exec` identity rather
      // than the tool's own name. Left as `name`, an `Exec(...)` grant would
      // never be consulted — the call would run under RunCommand's own grant
      // (often a wildcard for its declared commands), making the allowlist
      // decorative. The tool's registered name is unaffected; this changes
      // only which identity the policy and ledger see for THIS call.
      const argvField = tool.scope.argvField;
      const hasArgv = argvField !== undefined && input[argvField] !== undefined;
      const policyIdentity = hasArgv ? EXEC_TOOL_NAME : name;

      const verdict = opts.policy.check(policyIdentity, tool.scope, input);

      /**
       * Executes a permitted call and records its outcome. Shared by the
       * ordinary allow path and an ask verdict an AskResolver approved, so an
       * approved call behaves exactly as a grant would have.
       */
      async function runTool(
        target: CodingTool,
        callInput: Record<string, unknown>,
        resolvedPaths: readonly string[],
      ): Promise<CodingToolOutcome> {
        try {
          const result = await target.run(callInput, {
            root: opts.policy.root,
            resolvedPaths,
            maxBytes,
            maxFileBytes,
            ...(opts.denyPaths !== undefined ? { denyPaths: opts.denyPaths } : {}),
          });
          const kind = result.isError === true ? "error" : "ok";
          log(
            policyIdentity,
            kind,
            result.content.length,
            callInput,
            false,
            kind === "error" ? result.content : undefined,
            target.routineErrors,
            result.audit,
            result.resultBytesPreTruncation,
          );
          return { kind, content: result.content };
        } catch (err) {
          const content = err instanceof Error ? err.message : String(err);
          log(policyIdentity, "error", content.length, callInput, false, content, target.routineErrors);
          return { kind: "error", content };
        }
      }

      if (!verdict.allowed && verdict.outcome === "ask") {
        let decision: "allow" | "deny";
        try {
          decision = await askResolver.resolve({
            tool: policyIdentity,
            stage: opts.pipelineStage ?? "unknown",
            rule: verdict.rule ?? verdict.reason,
            summary: askSummary(policyIdentity, tool.scope, input),
          });
        } catch (err) {
          const content = errorMessage(err);
          log(policyIdentity, "error", content.length, input, false, content);
          return { kind: "error", content };
        }
        if (decision === "allow") {
          // Approved: run with what the policy resolved for this call.
          return runTool(tool, input, verdict.resolvedPaths ?? []);
        }
        const reason = `${verdict.reason} -- ${ASK_UNAVAILABLE_REASON}`;
        log(policyIdentity, "denied:ask", reason.length, input, false, reason);
        return { kind: "denied", reason, breach: false };
      }

      if (!verdict.allowed) {
        if (verdict.breach) {
          // In band so an unattended run survives one bad path guess, but loud:
          // a path escaping the root can indicate prompt injection.
          getSafeLogger()?.warn("tools", "[policy] path resolved outside the permitted root", {
            tool: policyIdentity,
            reason: verdict.reason,
            root: opts.policy.root,
          });
        }
        const commandField = tool.scope.commandField;
        const rawCommand = commandField === undefined ? undefined : input[commandField];
        const rawArgv = argvField === undefined ? undefined : input[argvField];
        const verbField = tool.scope.verbField;
        const rawVerb = verbField === undefined ? undefined : input[verbField];
        const declared = opts.declaredCommands ?? new Set<string>();
        // An argv call and a verb call deny through different policy branches;
        // before #1971 only the first could reach a redirect at all.
        const extra =
          typeof rawCommand === "string"
            ? redirectForCommand(rawCommand, advertisedNames, declared)
            : Array.isArray(rawArgv)
              ? redirectForArgv(rawArgv as readonly string[], advertisedNames, declared)
              : typeof rawVerb === "string"
                ? redirectForVerb(name, rawVerb, advertisedNames, declared)
                : undefined;
        const reason = extra === undefined ? verdict.reason : `${verdict.reason} -- ${extra}`;
        log(policyIdentity, "denied", reason.length, input, verdict.breach, reason);
        return { kind: "denied", reason, breach: verdict.breach };
      }

      return runTool(tool, input, verdict.resolvedPaths);
    },
  };
}
