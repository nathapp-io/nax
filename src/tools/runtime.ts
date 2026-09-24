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

import { randomUUID } from "node:crypto";
import { type CommandShadow, openShadowTap } from "@/command-safety";
import { getSafeLogger } from "@/logger";
import {
  ASK_CANCELLED_REASON,
  ASK_DENIED_REASON,
  ASK_NO_CHANNEL_REASON,
  ASK_TIMEOUT_REASON,
  type AskControl,
  type AskResolver,
  type AskVerdict,
  headlessAskResolver,
} from "@/permissions";
import { errorMessage } from "@/utils/errors";
import type { SandboxRecord } from "../sandbox";
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
import { applyModelTruncationPolicy } from "./spill";
import { createNoOpToolAuditSink, type ToolAuditSink } from "./tool-audit";
import { READ_CEILING } from "./truncate";
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
  | {
      readonly kind: "ok" | "error";
      readonly content: string;
      /** Records the final model-facing content when shaping was deferred. */
      readonly finalizeAudit?: (content: string) => void;
    }
  | { readonly kind: "denied"; readonly reason: string; readonly breach: boolean };

/** Injectable logger seam, mirroring _pullToolsDeps.getLogger. */
export const _codingToolDeps = { getLogger: getSafeLogger };

/** Per-call context. Identity fields are recorded on the audit ledger. */
export interface ToolCallContext {
  readonly turnId?: string;
  readonly roundTrips?: number;
  readonly toolCallId?: string;
  /** Return the full result so a downstream model-facing chokepoint can shape it. */
  readonly deferModelTruncation?: boolean;
  /**
   * US-002: the turn's abort signal, forwarded from the native coding-tool
   * request. `runTool` copies it onto the `ToolRunContext` so the tool can
   * stop in-flight work (Bash/Exec SIGKILL their process group) when the
   * turn is cancelled, exactly as the runtime-level `signal` does when no
   * per-call signal is present.
   */
  readonly signal?: AbortSignal;
  /**
   * US-002: notifies the runtime's caller (and through it the turn loop)
   * that this tool is about to WAIT on something external, so an idle
   * watchdog does not time it out. Forwarded from the native coding-tool
   * request; tools that wait on a human call it before blocking.
   */
  readonly onWaiting?: () => void;
}

export interface CodingToolRuntime {
  /** Op declaration intersected with policy grants. Both can only narrow. */
  advertised(declared: readonly string[]): readonly CodingTool[];
  callTool(name: string, input: Record<string, unknown>, context?: ToolCallContext): Promise<CodingToolOutcome>;
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

/**
 * The reason a `denied:ask` ledger row carries, chosen by WHO refused.
 *
 * One constant for every ask denial asserted "no approval channel is
 * configured" even when a human answered (deny) or nobody answered in time
 * (timeout). Those are materially different facts; see ASK_*_REASON.
 */
function askDenyReason(decidedBy: AskVerdict["decidedBy"]): string {
  if (decidedBy === "timeout") return ASK_TIMEOUT_REASON;
  if (decidedBy === "human") return ASK_DENIED_REASON;
  if (decidedBy === "cancelled") return ASK_CANCELLED_REASON;
  return ASK_NO_CHANNEL_REASON;
}

export function createCodingToolRuntime(opts: {
  policy: ToolPolicy;
  maxBytes?: number;
  maxFileBytes?: number;
  /**
   * Tool-layer I/O bound. Defaults to `READ_CEILING` when absent — tools
   * bound their reads to this ceiling before any model-facing truncation
   * policy runs. Distinct from `maxBytes` (model-facing) and `maxFileBytes`
   * (whole-file Edit/Write cap).
   */
  readCeiling?: number;
  /**
   * Aborts in-flight tool work (US-001). Bash and RunCommand's argv branch
   * forward it to their launcher / runArgv call, which SIGKILLs the process
   * group. Optional so existing callers compile unchanged.
   */
  signal?: AbortSignal;
  storyId?: string;
  callId?: string;
  scopeId?: string;
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
  /**
   * P5 shadow classifier (spec 2026-09-23-p5-command-safety-shadow-design.md).
   * Observational only: it never changes a verdict, delays or fails a call.
   */
  commandShadow?: CommandShadow;
}): CodingToolRuntime {
  registerBuiltinCodingTools();
  // The global registry cannot hold session-local tools like RunCommand (its
  // declared commands are per-project). Consult this layer before the registry.
  const extra = new Map((opts.extraTools ?? []).map((t) => [t.name, t]));
  const lookup = (name: string): CodingTool | undefined => extra.get(name) ?? getCodingTool(name);
  const sink = opts.sink ?? createNoOpToolAuditSink();
  const maxBytes = opts.maxBytes ?? DEFAULT_TOOL_MAX_BYTES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_TOOL_MAX_FILE_BYTES;
  const readCeiling = opts.readCeiling ?? READ_CEILING;
  const askResolver = opts.askResolver ?? headlessAskResolver();
  const granted = new Set(opts.policy.grantedTools());
  // Captured so the `ToolRunContext` constructed inside `runTool` carries the
  // session-wide abort signal; tools (Bash, Exec's argv branch) forward it
  // into their launcher / runArgv call so turn cancellation reaches the
  // process group. US-001.
  const signal = opts.signal;

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
    context: ToolCallContext | undefined,
    breach?: boolean,
    reason?: string,
    routineErrors?: boolean,
    audit?: {
      executed?: readonly string[];
      target?: "package" | "repoRoot";
      approval?: { decidedBy: string; remembered: boolean; latencyMs: number };
      sandbox?: SandboxRecord;
    },
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
      ...(audit?.approval !== undefined ? { approval: audit.approval } : {}),
      ...(audit?.sandbox !== undefined ? { sandbox: audit.sandbox } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(resultBytesPreTruncation !== undefined ? { resultBytesPreTruncation } : {}),
      ...(opts.callId !== undefined ? { callId: opts.callId } : {}),
      ...(opts.scopeId !== undefined ? { scopeId: opts.scopeId } : {}),
      ...(context?.turnId !== undefined ? { turnId: context.turnId } : {}),
      ...(context?.roundTrips !== undefined ? { roundTrips: context.roundTrips } : {}),
      ...(context?.toolCallId !== undefined ? { toolCallId: context.toolCallId } : {}),
    });
  }

  async function shapeToolResult(
    body: string,
    toolName: string,
    context: ToolCallContext | undefined,
  ): Promise<string> {
    if (context?.deferModelTruncation === true) return body;
    return applyModelTruncationPolicy(body, {
      toolName,
      callId: context?.toolCallId ?? randomUUID(),
      root: opts.policy.root,
      maxBytes,
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

    async callTool(name, input, context) {
      const tool = lookup(name);
      if (tool === undefined) {
        const reason = `unknown tool "${name}"`;
        log(name, "denied", 0, input, context, false, reason);
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

      // P5: observe the command now (not awaited), settle from logCall below.
      const tap =
        opts.commandShadow === undefined
          ? undefined
          : openShadowTap(opts.commandShadow, {
              key: randomUUID(),
              identity: policyIdentity,
              command: tool.scope.commandField === undefined ? undefined : input[tool.scope.commandField],
              argv: hasArgv && argvField !== undefined ? input[argvField] : undefined,
              verdict,
              stage: opts.pipelineStage ?? "unknown",
              ...(opts.storyId !== undefined ? { storyId: opts.storyId } : {}),
            });
      // Every ledger outcome of this call settles the tap exactly once, with
      // `denied:ask` and `decidedBy` intact -- which CodingToolOutcome.kind
      // alone would lose (spec 4.2).
      const logCall: typeof log = (...args) => {
        log(...args);
        tap?.settle(args[1], args[8]?.approval?.decidedBy);
      };

      /**
       * Executes a permitted call and records its outcome. Shared by the
       * ordinary allow path and an ask verdict an AskResolver approved, so an
       * approved call behaves exactly as a grant would have.
       *
       * The result is shaped by `applyModelTruncationPolicy` before it is
       * returned, which is what makes the model-facing cap one policy rather
       * than one per tool: the tools bound their own I/O at `ctx.readCeiling`,
       * and this is where the byte/line ceilings the model experiences — and
       * the spill of whatever they cut — are applied. The native session
       * applies the same policy at its `after_tool` chokepoint, so a call made
       * through the loop and one made directly see the same shaping.
       */
      async function runTool(
        target: CodingTool,
        callInput: Record<string, unknown>,
        resolvedPaths: readonly string[],
        approval?: { decidedBy: string; remembered: boolean; latencyMs: number },
      ): Promise<CodingToolOutcome> {
        // US-002 AC15: a per-call `ToolCallContext.signal` (the native batch's
        // turn signal) takes priority over the runtime-level signal. Both
        // describe "abort this in-flight tool"; the per-call one is the one
        // the batch explicitly put in scope, so it wins when both are
        // present, falling back to the runtime-level signal otherwise so the
        // session-wide abort keeps working when no per-call signal is in
        // scope.
        const callSignal = context?.signal ?? signal;
        try {
          const result = await target.run(callInput, {
            root: opts.policy.root,
            resolvedPaths,
            maxBytes,
            maxFileBytes,
            readCeiling,
            ...(opts.denyPaths !== undefined ? { denyPaths: opts.denyPaths } : {}),
            ...(callSignal !== undefined ? { signal: callSignal } : {}),
          });
          const kind = result.isError === true ? "error" : "ok";
          const content = await shapeToolResult(result.content, policyIdentity, context);
          const record = (finalContent: string) =>
            logCall(
              policyIdentity,
              kind,
              finalContent.length,
              callInput,
              context,
              false,
              kind === "error" ? result.content : undefined,
              target.routineErrors,
              { ...result.audit, ...(approval ? { approval } : {}) },
              result.resultBytesPreTruncation,
            );
          if (context?.deferModelTruncation === true) return { kind, content, finalizeAudit: record };
          record(content);
          return { kind, content };
        } catch (err) {
          const rawContent = err instanceof Error ? err.message : String(err);
          const content = await shapeToolResult(rawContent, policyIdentity, context);
          const record = (finalContent: string) =>
            logCall(
              policyIdentity,
              "error",
              finalContent.length,
              callInput,
              context,
              false,
              rawContent,
              target.routineErrors,
              approval ? { approval } : undefined,
            );
          if (context?.deferModelTruncation === true) {
            return { kind: "error", content, finalizeAudit: record };
          }
          record(content);
          return { kind: "error", content };
        }
      }

      if (!verdict.allowed && verdict.outcome === "ask") {
        // US-003: build the AskControl from the per-call context. The turn's
        // abort signal is forwarded verbatim, and onWaiting is wired so the
        // resolver can tell the turn loop a human prompt is pending.
        const callSignal = context?.signal ?? signal;
        const askControl: AskControl = {
          ...(callSignal !== undefined ? { signal: callSignal } : {}),
          ...(context?.onWaiting !== undefined ? { onWaiting: context.onWaiting } : {}),
        };
        let askVerdict: AskVerdict;
        try {
          askVerdict = await askResolver.resolve(
            {
              tool: policyIdentity,
              stage: opts.pipelineStage ?? "unknown",
              rule: verdict.rule ?? verdict.reason,
              summary: askSummary(policyIdentity, tool.scope, input),
              ...(typeof input[tool.scope.commandField ?? ""] === "string"
                ? { command: input[tool.scope.commandField as string] as string }
                : {}),
              root: opts.policy.root,
              reason: verdict.reason,
              ...(opts.storyId !== undefined ? { storyId: opts.storyId } : {}),
            },
            askControl,
          );
        } catch (err) {
          const content = errorMessage(err);
          logCall(policyIdentity, "error", content.length, input, context, false, content);
          return { kind: "error", content };
        }
        const approval = {
          decidedBy: askVerdict.decidedBy,
          remembered: false,
          latencyMs: askVerdict.latencyMs,
        };
        if (askVerdict.decision === "allow") {
          // US-003 AC11: recheck the turn signal AFTER the resolver returned
          // allow. A resolver that approves after the turn has been cancelled
          // would otherwise race ahead and execute the tool; we deny instead
          // with the same cancelled reason, so the agent never sees a tool
          // result from a turn that has already ended.
          if (callSignal?.aborted === true) {
            const reason = `${verdict.reason} -- ${ASK_CANCELLED_REASON}`;
            logCall(policyIdentity, "denied:ask", reason.length, input, context, false, reason, undefined, {
              approval,
            });
            return { kind: "denied", reason, breach: false };
          }
          return runTool(tool, input, verdict.resolvedPaths ?? [], approval);
        }
        const reason = `${verdict.reason} -- ${askDenyReason(askVerdict.decidedBy)}`;
        logCall(policyIdentity, "denied:ask", reason.length, input, context, false, reason, undefined, { approval });
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
        logCall(policyIdentity, "denied", reason.length, input, context, verdict.breach, reason);
        return { kind: "denied", reason, breach: verdict.breach };
      }

      return runTool(tool, input, verdict.resolvedPaths);
    },
  };
}
