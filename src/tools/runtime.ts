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
import { editTool } from "./edit";
import { gitTool } from "./git";
import { gitCommitTool } from "./git-commit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readTool } from "./read";
import { type CodingTool, getCodingTool, registerBuiltinTool } from "./registry";
import { requestCapabilityTool } from "./request-capability";
import { createNoOpToolAuditSink, type ToolAuditSink } from "./tool-audit";
import { EXEC_TOOL_NAME, type ToolPolicy } from "./types";
import { writeTool } from "./write";

/** Per-call output ceiling, mirroring ToolDescriptor.maxTokensPerCall in spirit. */
export const DEFAULT_TOOL_MAX_BYTES = 40_000;

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
    gitTool,
    gitCommitTool,
    requestCapabilityTool,
  ]) {
    if (getCodingTool(tool.name) === undefined) registerBuiltinTool(tool);
  }
  builtinsRegistered = true;
}

/** @internal Test-only: pairs with _resetRegistryForTest. */
export function _resetBuiltinsForTest(): void {
  builtinsRegistered = false;
}

export function createCodingToolRuntime(opts: {
  policy: ToolPolicy;
  maxBytes?: number;
  maxFileBytes?: number;
  storyId?: string;
  sink?: ToolAuditSink;
  extraTools?: readonly CodingTool[];
}): CodingToolRuntime {
  registerBuiltinCodingTools();
  // The global registry cannot hold session-local tools like RunCommand (its
  // declared commands are per-project). Consult this layer before the registry.
  const extra = new Map((opts.extraTools ?? []).map((t) => [t.name, t]));
  const lookup = (name: string): CodingTool | undefined => extra.get(name) ?? getCodingTool(name);
  const sink = opts.sink ?? createNoOpToolAuditSink();
  const maxBytes = opts.maxBytes ?? DEFAULT_TOOL_MAX_BYTES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_TOOL_MAX_FILE_BYTES;
  const granted = new Set(opts.policy.grantedTools());

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
    outcome: CodingToolOutcome["kind"],
    resultBytes: number,
    input: Record<string, unknown>,
    breach?: boolean,
    reason?: string,
    routineErrors?: boolean,
  ): void {
    // The level is the console filter: `normal` mode drops debug, and the file
    // sink writes every level regardless, so demoting keeps the record without
    // spending an operator's attention on it. A breach is the one outcome that
    // can indicate prompt injection, so it alone reaches `error`.
    const level =
      outcome === "denied"
        ? breach === true
          ? "error"
          : "warn"
        : outcome === "error" && !routineErrors
          ? "warn"
          : "debug";

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
        log(policyIdentity, "denied", verdict.reason.length, input, verdict.breach, verdict.reason);
        return { kind: "denied", reason: verdict.reason, breach: verdict.breach };
      }

      try {
        const result = await tool.run(input, {
          root: opts.policy.root,
          resolvedPaths: verdict.resolvedPaths,
          maxBytes,
          maxFileBytes,
        });
        const kind = result.isError === true ? "error" : "ok";
        log(
          policyIdentity,
          kind,
          result.content.length,
          input,
          false,
          kind === "error" ? result.content : undefined,
          tool.routineErrors,
        );
        return { kind, content: result.content };
      } catch (err) {
        const content = err instanceof Error ? err.message : String(err);
        log(policyIdentity, "error", content.length, input, false, content, tool.routineErrors);
        return { kind: "error", content };
      }
    },
  };
}
