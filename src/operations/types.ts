import type { RetryPreset, RetryStrategy } from "../agents/retry";
import type { TurnResult } from "../agents/types";
import type { ConfigSelector, ConfiguredModel } from "../config";
import type { NaxConfig } from "../config";
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
   * Optional. Validate parsed output against on-disk artifacts. Returning
   * non-null wins; returning null means "parsed output insufficient — fall
   * through to recover (if defined) or return the original parsed value".
   *
   * Use when the agent's contract is "stdout has the answer, but disk has
   * the canonical artifact" (e.g. ACP test-writer: stdout is conversational,
   * disk has the test file). See ADR-020 §D4.
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
   * When true, callOp wraps the adapter as a fallback-less manager so the op
   * runs single-agent. Used by TDD ops to preserve the established
   * `fallbacks: []` invariant. ADR-018 §5.2.
   */
  readonly noFallback?: boolean;
  /**
   * Optional intra-hop multi-prompt body. See HopBody / HopBodyContext.
   * Used by review ops to perform a same-session JSON-parse retry.
   */
  readonly hopBody?: HopBody<I>;
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
  readonly retry?: RetryPreset | RetryStrategy | ((input: I, ctx: BuildContext<C>) => RetryPreset | undefined);
}

/**
 * Operation model selector — literal value or resolver function.
 *
 * Resolver form lets ops derive the selection from per-call input or per-package
 * config (e.g. `(input) => input.semanticConfig.model`). Mirrors the shape of
 * `OperationBase.timeoutMs` so per-op runtime customization is uniform.
 */
export type OperationModel<I, C> = ConfiguredModel | ((input: I, ctx: BuildContext<C>) => ConfiguredModel | undefined);

export type Operation<I, O, C> = RunOperation<I, O, C> | CompleteOperation<I, O, C>;
