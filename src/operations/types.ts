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
  /** Reserved for future model-tier override; not yet consumed by callOp (Wave 3). */
  readonly mode?: string;
  /**
   * Model selection for this op. Accepts either a tier label
   * ("fast" | "balanced" | "powerful") or an explicit `{ agent, model }`
   * pin (for cross-agent or shorthand-aliased model overrides). Resolved via
   * `resolveConfiguredModel` in callOp. Defaults to "balanced" when omitted.
   */
  readonly model?: ConfiguredModel;
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
   * Model selection for this call. Accepts a tier label or an explicit
   * `{ agent, model }` pin. Resolved via `resolveConfiguredModel` in callOp.
   * Defaults to "balanced" when omitted.
   */
  readonly model?: ConfiguredModel;
}

export type Operation<I, O, C> = RunOperation<I, O, C> | CompleteOperation<I, O, C>;

/** Parsed finding shape returned by LLM reviewer ops (semantic-review, adversarial-review). */
export interface LlmReviewFinding {
  severity: string;
  file: string;
  line?: number;
  issue: string;
  suggestion?: string;
  /** Adversarial review only — finding category (input, error-path, abandonment, etc.). */
  category?: string;
  /** Semantic review only — acceptance criterion ID this finding is linked to. */
  acId?: string;
  /**
   * Semantic review ref-mode only — evidence that the finding was verified against
   * current files. Used by sanitizeRefModeFindings to downgrade unverified findings.
   */
  verifiedBy?: {
    command?: string;
    file: string;
    line?: number;
    observed: string;
  };
}
