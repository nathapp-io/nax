import type { TokenUsage } from "../agents/cost";
import type { PipelineStage, ResolvedPermissions } from "../config/permissions";
import { getSafeLogger } from "../logger";
import type { AdvisoryFinding } from "../review/review-audit";
import { errorMessage } from "../utils/errors";
import type { SessionRole } from "./session-role";

/**
 * Fields every dispatch event carries, regardless of kind. New cross-cutting
 * fields (e.g. traceId, packageId) go here once; both variants and every
 * subscriber pick them up via the compiler.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D1
 */
export interface DispatchEventBase {
  readonly sessionName: string;
  readonly sessionRole: SessionRole;
  readonly prompt: string;
  readonly response: string;
  readonly agentName: string;
  /**
   * Concrete model the call ran on (e.g. "haiku", "sonnet"), from the resolved
   * `ModelDef`. Absent only when the dispatch had no resolved model to report.
   *
   * Attribution only — subscribers record it, never branch on it. Before #1433
   * the cost middleware hardcoded `"unknown"` here because this field did not
   * exist, which made every model-level cost question unanswerable.
   */
  readonly model?: string;
  /** Tier `model` resolved from, when it came from one. Attribution only. */
  readonly modelTier?: string;
  /**
   * Reasoning effort from a nax-level `model[effort]` profile suffix
   * (`parseModelSpec`), when the resolved model spec carried one. Absent for
   * bare model ids — currently only codex profiles carry a suffix. Attribution
   * only; subscribers record it, never branch on it.
   */
  readonly effort?: string;
  /**
   * Resolved run-profile chain as a display string ("cc-acceptance", "a+b", or
   * "default"). Profiles repoint agent and model per stage but appear nowhere
   * else in run artifacts, so without this a cost row cannot distinguish a
   * deliberate model pin from a stage silently ignoring its configured tier.
   */
  readonly profile?: string;
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly featureName?: string;
  readonly workdir?: string;
  readonly projectDir?: string;
  readonly resolvedPermissions: ResolvedPermissions;
  readonly tokenUsage?: TokenUsage;
  readonly estimatedCostUsd?: number;
  readonly exactCostUsd?: number;
  readonly durationMs: number;
  readonly timestamp: number;
  /**
   * Which rate card priced the call, reported by the producer
   * (`CompleteResult.pricingSource` / `TurnResult.pricingSource`, US-003).
   * Carried on the event so the cost subscriber can prefer the producer's
   * answer over the model-derived default (`resolvePricingSource(model)`) —
   * exactly as it already prefers a wire-exact cost over an estimate on the
   * same line. The ACP path supplies no value, in which case the subscriber
   * falls back to the model-derived label, preserving pre-US-004 behaviour
   * exactly. Optional on both kinds because the union deliberately widens
   * with new producer-supplied values (US-004).
   */
  readonly pricingSource?:
    | "wire"
    | "model-rates"
    | "fallback-rates"
    | "unknown-model"
    | "catalog-rates"
    | "config-override";
  /** Per-callOp invocation id, stamped by the operation layer. */
  readonly callId?: string;
  /** Caller-supplied region id forwarded from CallContext.scopeId. */
  readonly scopeId?: string;
}

export interface SessionTurnDispatchEvent extends DispatchEventBase {
  readonly kind: "session-turn";
  /**
   * Round-trips inside this turn. The UNIT differs by transport, which is why
   * `roundTripUnit` travels with it: on ACP each round-trip is a complete
   * delegated agent run, on native each is a single model call.
   */
  readonly roundTrips: number;
  readonly roundTripUnit: "model-call" | "agent-run";
  readonly protocolIds: { sessionId?: string | null; recordId?: string | null; turnId?: string };
  /**
   * Mid-turn human-in-the-loop Q&A exchanges captured during the turn (issue #1226).
   * Present only when the agent asked the operator a question that was answered.
   * Surfaced to the prompt-audit trail by the audit middleware.
   */
  readonly interactions?: readonly import("../agents/types").InteractionExchange[];
  /** Diagnostic only — never branch subscriber logic on this. */
  readonly origin: "runAsSession" | "runTrackedSession";
}

export interface CompleteDispatchEvent extends DispatchEventBase {
  readonly kind: "complete";
  /**
   * Backend session id the adapter reported on its `CompleteResult`. Carried
   * here as a plain field rather than inside the sibling `protocolIds` object
   * because a one-shot has no record id and no turn id (US-002). Absent when
   * the adapter does not derive a session id (legacy acpx/Claude one-shots).
   */
  readonly sessionId?: string;
}

export type DispatchEvent = SessionTurnDispatchEvent | CompleteDispatchEvent;

export interface OperationCompletedEvent {
  readonly kind: "operation-completed";
  readonly operation: "run-with-fallback" | "complete-with-fallback";
  readonly agentChain: readonly string[];
  readonly hopCount: number;
  readonly fallbackTriggered: boolean;
  readonly totalElapsedMs: number;
  readonly totalCostUsd: number;
  readonly finalStatus: "ok" | "exhausted" | "cancelled" | "error";
  readonly storyId?: string;
  readonly stage: PipelineStage;
  readonly timestamp: number;
  readonly callId?: string;
  readonly scopeId?: string;
}

export interface DispatchErrorEvent {
  readonly kind: "error";
  readonly origin: "runAsSession" | "runTrackedSession" | "completeAs";
  readonly agentName: string;
  readonly stage: PipelineStage;
  readonly storyId?: string;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly prompt?: string;
  readonly durationMs: number;
  readonly timestamp: number;
  readonly resolvedPermissions: ResolvedPermissions;
  readonly callId?: string;
  readonly scopeId?: string;
}

export interface ReviewDecisionEvent {
  readonly kind: "review-decision";
  readonly runId?: string;
  readonly reviewer: "semantic" | "adversarial";
  readonly workdir?: string;
  readonly projectDir?: string;
  readonly outputDir?: string;
  readonly sessionName?: string;
  readonly sessionId?: string | null;
  readonly recordId?: string | null;
  readonly agentName?: string;
  readonly storyId?: string;
  readonly featureName?: string;
  readonly timestamp: number;
  readonly parsed: boolean;
  readonly looksLikeFail?: boolean;
  readonly failOpen?: boolean;
  readonly passed?: boolean;
  readonly blockingThreshold?: "error" | "warning" | "info";
  readonly result: { passed: boolean; findings: unknown[] } | null;
  readonly advisoryFindings?: readonly AdvisoryFinding[];
  /**
   * #1423 — prior findings the reviewer resolved or withdrew this round.
   * Carried separately from `result.findings` so acknowledgements are visible
   * without being counted as defects.
   */
  readonly acks?: readonly unknown[];
  /** Findings deleted by the AC-grounding filter — invisible everywhere else. */
  readonly acDropped?: readonly unknown[];
  /** Clipped preview of output that failed to parse, for post-hoc give-up diagnosis. */
  readonly unparsedPreview?: string;
  /** Issue #986 — adversarial-only structural-gate counterfactual telemetry. */
  readonly diffAvailable?: boolean;
  readonly adversarialDropAnalysis?: readonly unknown[];
  readonly adversarialAcceptAnalysis?: readonly unknown[];
  /** Set when the adversarial check passed due to all drops being ac_quote_not_substring. */
  readonly passReason?: string;
}

export interface ReviewRepromptEvent {
  readonly kind: "review-reprompt-on-drop";
  readonly storyId: string;
  readonly reviewer: "adversarial" | "semantic";
  readonly dropCount: number;
  readonly repromptOutcome: "recovered-blocking" | "recovered-advisory-only" | "still-dropped" | "parse-failed";
  readonly costUsd: number;
}

export type DispatchListener = (event: DispatchEvent) => void;
export type OperationCompletedListener = (event: OperationCompletedEvent) => void;
export type DispatchErrorListener = (event: DispatchErrorEvent) => void;
export type ReviewDecisionListener = (event: ReviewDecisionEvent) => void;
export type ReviewRepromptListener = (event: ReviewRepromptEvent) => void;

export interface IDispatchEventBus {
  onDispatch(listener: DispatchListener): () => void;
  onOperationCompleted(listener: OperationCompletedListener): () => void;
  onDispatchError(listener: DispatchErrorListener): () => void;
  onReviewDecision(listener: ReviewDecisionListener): () => void;
  onReviewReprompt(listener: ReviewRepromptListener): () => void;
  emitDispatch(event: DispatchEvent): void;
  emitOperationCompleted(event: OperationCompletedEvent): void;
  emitDispatchError(event: DispatchErrorEvent): void;
  emitReviewDecision(event: ReviewDecisionEvent): void;
  emitReviewReprompt(event: ReviewRepromptEvent): void;
}

export class DispatchEventBus implements IDispatchEventBus {
  private readonly _dispatchListeners = new Set<DispatchListener>();
  private readonly _completedListeners = new Set<OperationCompletedListener>();
  private readonly _errorListeners = new Set<DispatchErrorListener>();
  private readonly _reviewDecisionListeners = new Set<ReviewDecisionListener>();
  private readonly _reviewRepromptListeners = new Set<ReviewRepromptListener>();

  onDispatch(l: DispatchListener): () => void {
    this._dispatchListeners.add(l);
    return () => this._dispatchListeners.delete(l);
  }

  onOperationCompleted(l: OperationCompletedListener): () => void {
    this._completedListeners.add(l);
    return () => this._completedListeners.delete(l);
  }

  onDispatchError(l: DispatchErrorListener): () => void {
    this._errorListeners.add(l);
    return () => this._errorListeners.delete(l);
  }

  onReviewDecision(l: ReviewDecisionListener): () => void {
    this._reviewDecisionListeners.add(l);
    return () => this._reviewDecisionListeners.delete(l);
  }

  onReviewReprompt(l: ReviewRepromptListener): () => void {
    this._reviewRepromptListeners.add(l);
    return () => this._reviewRepromptListeners.delete(l);
  }

  emitDispatch(event: DispatchEvent): void {
    for (const l of this._dispatchListeners) {
      try {
        l(event);
      } catch (err) {
        getSafeLogger()?.warn("dispatch-bus", "listener threw", { error: errorMessage(err) });
      }
    }
  }

  emitOperationCompleted(event: OperationCompletedEvent): void {
    for (const l of this._completedListeners) {
      try {
        l(event);
      } catch (err) {
        getSafeLogger()?.warn("dispatch-bus", "completion-listener threw", { error: errorMessage(err) });
      }
    }
  }

  emitDispatchError(event: DispatchErrorEvent): void {
    for (const l of this._errorListeners) {
      try {
        l(event);
      } catch (err) {
        getSafeLogger()?.warn("dispatch-bus", "error-listener threw", { error: errorMessage(err) });
      }
    }
  }

  emitReviewDecision(event: ReviewDecisionEvent): void {
    for (const l of this._reviewDecisionListeners) {
      try {
        l(event);
      } catch (err) {
        getSafeLogger()?.warn("dispatch-bus", "review-decision-listener threw", { error: errorMessage(err) });
      }
    }
  }

  emitReviewReprompt(event: ReviewRepromptEvent): void {
    for (const l of this._reviewRepromptListeners) {
      try {
        l(event);
      } catch (err) {
        getSafeLogger()?.warn("dispatch-bus", "review-reprompt-listener threw", { error: errorMessage(err) });
      }
    }
  }
}
