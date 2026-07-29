import type { RetryPreset, RetryStrategy } from "../agents/retry";
import type { TurnResult } from "../agents/types";
import type { ConfigSelector, ConfiguredModel } from "../config";
import type { NaxConfig, TestStrategy } from "../config";
import type { PipelineStage } from "../config/permissions";
import type { ComposeInput } from "../prompts/compose";
import type { NaxRuntime, PackageView } from "../runtime";
import type { SessionRole } from "../session/types";

export interface BuildContext<C> {
  readonly packageView: PackageView;
  readonly config: C;
}

export interface CallContext {
  readonly runtime: NaxRuntime;
  readonly packageView: PackageView;
  readonly packageDir: string;
  readonly storyId?: string;
  readonly featureName?: string;
  /**
   * Absolute path to the feature directory (`.nax/features/<name>/`), when
   * known. Input-side: consumed by the checkpoint/resume seam
   * (`_storyOrchestratorDeps.loadCheckpoints`) to locate `checkpoint.jsonl`
   * for the current feature. Absent for ad-hoc CLI calls with no feature
   * context.
   */
  readonly featureDir?: string;
  readonly agentName: string;
  readonly sessionOverride?: {
    readonly role?: SessionRole;
    readonly discriminator?: string | number;
  };
  /**
   * Optional full UserStory passed to buildHopCallback for cross-agent fallback
   * bundle rebuilds. When absent (e.g. ad-hoc CLI calls), callOp synthesizes a
   * minimal stub from `storyId` — sufficient for `kind:"run"` ops that don't
   * carry a context bundle. Bundle-aware ops should pass the real story.
   */
  readonly story?: import("../prd").UserStory;
  /**
   * Optional context bundle for kind:"run" ops that need context-engine pull
   * tools (e.g. review ops). Passed as the initial `bundle` to runWithFallback
   * so buildHopCallback can create contextToolRuntime for the first hop.
   */
  readonly contextBundle?: import("../context/engine").ContextBundle;
  /**
   * Optional interaction bridge for mid-session human Q&A. When set, the hop
   * callback wires an interactionHandler so the agent can ask questions and
   * receive answers without terminating the session.
   */
  readonly interactionBridge?: {
    detectQuestion: (text: string) => Promise<boolean>;
    onQuestionDetected: (text: string) => Promise<string>;
  };
  /** Max interaction round-trips when interactionBridge is active (default: 10). */
  readonly maxInteractionTurns?: number;
  /** Optional region id forwarded onto every dispatch event the op produces. */
  readonly scopeId?: string;
  /** Optional pinned callId. callOp generates a fresh one when absent. */
  readonly callId?: string;
  readonly phaseTelemetry?: {
    readonly testStrategy: TestStrategy;
    readonly sessionModel: "single-session" | "three-session";
    readonly tier: string;
  };
}

interface OperationBase<I, O, C> {
  readonly name: string;
  readonly stage: PipelineStage;
  readonly config: ConfigSelector<C> | readonly (keyof NaxConfig)[];
  readonly build: (input: I, ctx: BuildContext<C>) => ComposeInput;
  /**
   * Parse and validate the agent output into a typed domain value.
   *
   * Signature mirrors `build(input, ctx)` for symmetry — `parse` may consult
   * `input` and `ctx` (specifically `ctx.packageView.config` for full-config
   * lookups, `ctx.config` for the sliced view) to perform domain-aware
   * validation and derivation. Must remain side-effect-free: no I/O, no
   * agent calls, no runtime mutation.
   *
   * Widened from `(output) => O` post-Wave-1 (ADR-018 §4.1 amended) — see
   * Migration Anti-Patterns AP-3.
   */
  readonly parse: (output: string, input: I, ctx: BuildContext<C>) => O;
  /**
   * Optional operation-specific timeout resolver in milliseconds.
   * callOp uses this as the single timeout source and converts to seconds
   * only at runOptions boundaries for run-kind operations.
   */
  readonly timeoutMs?: (input: I, ctx: BuildContext<C>) => number | undefined;
  /**
   * Optional. Validate or post-process parsed output, optionally consulting on-disk artifacts.
   * Returning non-null wins; returning null means "parsed output insufficient — fall
   * through to recover (if defined) or return the original parsed value".
   *
   * Sanctioned uses:
   *   1. "stdout has the answer, but disk has the canonical artifact" (e.g. ACP test-writer:
   *      stdout is conversational, disk has the test file). See ADR-020 §D4.
   *   2. Post-parse filter pipeline that may consult disk (e.g. review ops: evidence
   *      substantiation against HEAD source files, AC-grounding validation). Review ops
   *      never return null from verify — they always return a filtered O value and rely
   *      on the caller reading that value directly, not falling through to recover.
   */
  readonly verify?: (parsed: O, input: I, ctx: VerifyContext<C>) => Promise<O | null>;
  /**
   * Optional. Recover output from on-disk artifacts when parse + verify
   * both produced "no useful result." Last resort before the caller sees
   * the null/empty value. See ADR-020 §D4.
   */
  readonly recover?: (input: I, ctx: VerifyContext<C>) => Promise<O | null>;
}

/**
 * Read-only context for verify/recover hooks. Mirrors BuildContext<C>'s narrow
 * surface plus filesystem reads. No agent calls, no writes, no runtime
 * mutation — both hooks operate on disk artifacts the agent may have
 * produced as side effects.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D4
 */
export interface VerifyContext<C> extends BuildContext<C> {
  readonly readFile: (path: string) => Promise<string | null>;
  readonly fileExists: (path: string) => Promise<boolean>;
}

/**
 * Context passed to a per-op `hopBody`. Exposes a bound `send(prompt)` closure
 * that dispatches one turn against the active hop's session via
 * `agentManager.runAsSession` (which fires the Wave-2 middleware chain). Ops
 * never see the SessionHandle or the AgentManager directly — those stay inside
 * `buildHopCallback`.
 */
export interface HopBodyContext<I> {
  readonly send: (prompt: string) => Promise<TurnResult>;
  /**
   * `send` plus the parse-retry loop declared by `op.retry`. Equal to `send`
   * when `op.retry` is unset — always safe to call.
   *
   * On retry exhaustion the last raw turn is returned (no throw). If the
   * strategy supplied `decision.fallback`, `callOp` captures it and uses it as
   * the final `O` when the outer `op.parse(rawOutput)` also fails. If the
   * outer parse succeeds (e.g. semantic's FAIL_OPEN heuristic), the fallback
   * is discarded — the outer parse wins.
   *
   * Each call to `sendWithParseRetry` has its own attempt counter and cost
   * accumulator — a body that calls it twice gets two independent retry budgets.
   * Note that fallback and exhaustion state (`retryFallback`, `maxRetriesExceeded`,
   * `lastRetryTurn` inside `callOp`) are tracked from the most recent call only;
   * earlier calls' fallback values do not survive a subsequent invocation. Bodies
   * that call `sendWithParseRetry` multiple times will see only the last call's
   * fallback state at the outer parse layer.
   *
   * **Probe semantics:** the strategy receives a `ParseValidationError` probe on
   * every turn unconditionally — it re-parses `ctx.lastOutput` internally to
   * decide whether the output is valid. Custom `RetryStrategy` implementations
   * used with `sendWithParseRetry` must implement this re-parse check; returning
   * `{ retry: true }` without checking `ctx.lastOutput` will cause over-retry.
   */
  readonly sendWithParseRetry: (prompt: string) => Promise<TurnResult>;
  readonly input: I;
}

/**
 * Optional multi-prompt body executed within a single hop's session.
 * When omitted, the default body is "send the initial prompt and return".
 * The body owns same-session retry logic (e.g. JSON parse retries in review ops).
 * It does NOT own openSession / closeSession / fallback iteration — those are
 * `buildHopCallback`'s job.
 */
export type HopBody<I> = (initialPrompt: string, ctx: HopBodyContext<I>) => Promise<TurnResult>;

export interface RunOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "run";
  /**
   * Model selection for this op. Accepts either:
   * - a `ConfiguredModel` literal (tier label like "fast"/"balanced"/"powerful"
   *   or an explicit `{ agent, model }` pin), or
   * - a resolver `(input, ctx) => ConfiguredModel | undefined` that derives the
   *   selection from per-call input or per-package config (e.g. semantic /
   *   adversarial review ops carry their tier on `input.semanticConfig.model`).
   *
   * A resolver returning `undefined` falls back to "balanced". Callop resolves
   * the final selection via `resolveConfiguredModel`.
   */
  readonly model?: OperationModel<I, C>;
  readonly session: {
    readonly role: SessionRole;
    readonly lifetime: "fresh" | "warm";
  };
  /**
   * Optional resolver for whether the session should remain open after the
   * turn. When omitted, callOp derives this from `session.lifetime`
   * (`warm` => keepOpen, `fresh` => close after turn).
   */
  readonly keepOpen?: (input: I, ctx: BuildContext<C>) => boolean;
  /**
   * When true, callOp wraps the adapter as a fallback-less manager so the op
   * runs single-agent. Used by TDD ops to preserve the established
   * `fallbacks: []` invariant. ADR-018 §5.2.
   */
  readonly noFallback?: boolean;
  /**
   * Optional intra-hop multi-prompt body. See HopBody / HopBodyContext.
   * Used by review ops for multi-turn orchestration (e.g. requoting findings).
   * When `op.retry` is also set, the body receives `ctx.sendWithParseRetry` —
   * a `send` variant with parse-retry baked in. Use `hopBody` for genuinely
   * multi-turn flows; use `retry` alone for simple parse-retry policies.
   */
  readonly hopBody?: HopBody<I>;
  /**
   * Optional retry policy for parse-validation failures on this op.
   * Accepts a `RetryPreset`, a `RetryStrategy`, or a resolver function.
   * When set without `hopBody`, `callOp` synthesises a hopBody that runs the
   * parse-retry loop inside one session. When set alongside `hopBody`, the
   * body receives `ctx.sendWithParseRetry` — a `send` variant that applies
   * this policy per call. The two fields compose; setting both is allowed.
   */
  readonly retry?:
    | RetryPreset
    | RetryStrategy
    | ((input: I, ctx: BuildContext<C>) => RetryPreset | RetryStrategy | undefined);
  /**
   * Optional file-output path resolver. When set, `callOp` reads this file
   * after each agent send (inside `sendWithParseRetry`) and replaces the
   * turn's text output with the file content before the retry probe fires.
   *
   * Use for ops where the agent writes its output to disk and replies with
   * a text confirmation (not JSON) — e.g. the plan op. This makes the probe
   * check the actual file content, so retries only fire when the file is
   * missing or contains invalid JSON, not on every text-confirmation turn.
   */
  readonly fileOutput?: (input: I) => string | undefined;
}

export interface CompleteOperation<I, O, C> extends OperationBase<I, O, C> {
  readonly kind: "complete";
  readonly jsonMode?: boolean;
  /**
   * Model selection for this call. Accepts a `ConfiguredModel` literal or a
   * resolver `(input, ctx) => ConfiguredModel | undefined`. Resolver returning
   * `undefined` falls back to "balanced". Resolved via `resolveConfiguredModel`
   * in callOp.
   */
  readonly model?: OperationModel<I, C>;
  /**
   * Optional retry policy for this op.
   * - `RetryPreset`: declarative config converted to `RetryStrategy` by `callOp`
   *   via `resolveRetryPreset`.
   * - `RetryStrategy`: custom strategy injected directly (discriminant: `"shouldRetry" in retry`).
   * - function: resolver reading per-call input and build context; return `undefined`
   *   to disable retry for this invocation.
   */
  readonly retry?:
    | RetryPreset
    | RetryStrategy
    | ((input: I, ctx: BuildContext<C>) => RetryPreset | RetryStrategy | undefined);
}

/**
 * Operation model selector — literal value or resolver function.
 *
 * Resolver form lets ops derive the selection from per-call input or per-package
 * config (e.g. `(input) => input.semanticConfig.model`). Mirrors the shape of
 * `OperationBase.timeoutMs` so per-op runtime customization is uniform.
 */
export type OperationModel<I, C> = ConfiguredModel | ((input: I, ctx: BuildContext<C>) => ConfiguredModel | undefined);

/**
 * DeterministicOperation — runs a pure function/filesystem call without an LLM session.
 * execute(input, ctx) is called directly by callOp, with no agent dispatch.
 * No cost tracking (no LLM involved), no session management.
 */
export interface DeterministicOperation<I, O, C = NaxConfig>
  extends Pick<OperationBase<I, O, C>, "name" | "stage" | "config"> {
  readonly kind: "deterministic";
  readonly timeoutMs?: never;
  execute(input: I, ctx: CallContext): Promise<O>;
}

export type Operation<I, O, C> = RunOperation<I, O, C> | CompleteOperation<I, O, C> | DeterministicOperation<I, O, C>;
