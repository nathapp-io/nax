import type { TokenUsage } from "../agents/cost";
import type { PipelineStage, ResolvedPermissions } from "../config/permissions";
import { getSafeLogger } from "../logger";
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
}

export interface SessionTurnDispatchEvent extends DispatchEventBase {
  readonly kind: "session-turn";
  readonly turn: number;
  readonly protocolIds: { sessionId?: string | null; recordId?: string | null; turnId?: string };
  /** Diagnostic only — never branch subscriber logic on this. */
  readonly origin: "runAsSession" | "runTrackedSession";
}

export interface CompleteDispatchEvent extends DispatchEventBase {
  readonly kind: "complete";
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
  readonly advisoryFindings?: unknown[];
}

export type DispatchListener = (event: DispatchEvent) => void;
export type OperationCompletedListener = (event: OperationCompletedEvent) => void;
export type DispatchErrorListener = (event: DispatchErrorEvent) => void;
export type ReviewDecisionListener = (event: ReviewDecisionEvent) => void;

export interface IDispatchEventBus {
  onDispatch(listener: DispatchListener): () => void;
  onOperationCompleted(listener: OperationCompletedListener): () => void;
  onDispatchError(listener: DispatchErrorListener): () => void;
  onReviewDecision(listener: ReviewDecisionListener): () => void;
  emitDispatch(event: DispatchEvent): void;
  emitOperationCompleted(event: OperationCompletedEvent): void;
  emitDispatchError(event: DispatchErrorEvent): void;
  emitReviewDecision(event: ReviewDecisionEvent): void;
}

export class DispatchEventBus implements IDispatchEventBus {
  private readonly _dispatchListeners = new Set<DispatchListener>();
  private readonly _completedListeners = new Set<OperationCompletedListener>();
  private readonly _errorListeners = new Set<DispatchErrorListener>();
  private readonly _reviewDecisionListeners = new Set<ReviewDecisionListener>();

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
}
