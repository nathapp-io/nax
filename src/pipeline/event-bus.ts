// RE-ARCH: keep
/**
 * Pipeline Event Bus (ADR-005, Phase 1)
 *
 * Typed publish/subscribe event bus for pipeline lifecycle events.
 * Replaces 20+ scattered fireHook() calls and 5+ getReporters() calls
 * with a single wiring point. Subscribers are registered once at startup.
 *
 * Phase 1: bus is created and exported. Existing hook/reporter calls
 * are NOT replaced until Phase 3 (subscriber consolidation).
 *
 * Design principles:
 * - Synchronous publish (fire-and-forget) — subscribers run async but bus
 *   does not await them, matching current fireHook() behavior
 * - Typed events via discriminated union
 * - Error isolation: one subscriber failure doesn't break others
 * - Zero dependencies on pipeline internals
 */

import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import type { VerifyResult } from "../verification/orchestrator-types";

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface StoryStartedEvent {
  type: "story:started";
  storyId: string;
  story: UserStory;
  workdir: string;
  /** Optional: passed by executor for hook subscriber */
  modelTier?: string;
  agent?: string;
  iteration?: number;
}

export interface StoryCompletedEvent {
  type: "story:completed";
  storyId: string;
  story: UserStory;
  passed: boolean;
  runElapsedMs: number;
  /** Optional: passed by executor/stage for hook/reporter subscribers */
  cost?: number;
  modelTier?: string;
  testStrategy?: string;
}

export interface StoryFailedEvent {
  type: "story:failed";
  storyId: string;
  story: UserStory;
  reason: string;
  countsTowardEscalation: boolean;
  /** Optional: passed by executor for interaction subscriber */
  feature?: string;
  attempts?: number;
}

export interface VerifyCompletedEvent {
  type: "verify:completed";
  storyId: string;
  result: VerifyResult;
}

export interface RectifyStartedEvent {
  type: "rectify:started";
  storyId: string;
  attempt: number;
  testOutput: string;
}

export interface RectifyCompletedEvent {
  type: "rectify:completed";
  storyId: string;
  attempt: number;
  fixed: boolean;
}

export interface AutofixStartedEvent {
  type: "autofix:started";
  storyId: string;
  command: string;
}

export interface AutofixCompletedEvent {
  type: "autofix:completed";
  storyId: string;
  fixed: boolean;
}

export interface RegressionDetectedEvent {
  type: "regression:detected";
  storyId: string;
  failedTests: number;
}

export interface RunCompletedEvent {
  type: "run:completed";
  totalStories: number;
  passedStories: number;
  failedStories: number;
  durationMs: number;
  totalCost?: number;
}

export interface HumanReviewRequestedEvent {
  type: "human-review:requested";
  storyId: string;
  reason: string;
  feature?: string;
  attempts?: number;
}

export interface RunStartedEvent {
  type: "run:started";
  feature: string;
  totalStories: number;
  workdir: string;
}

export interface RunPausedEvent {
  type: "run:paused";
  reason: string;
  storyId?: string;
  cost: number;
}

export interface StoryPausedEvent {
  type: "story:paused";
  storyId: string;
  reason: string;
  cost: number;
}

export interface StoryDecomposedEvent {
  type: "story:decomposed";
  storyId: string;
  story: UserStory;
  subStoryCount: number;
}

export interface RunResumedEvent {
  type: "run:resumed";
  feature: string;
}

export interface RunErroredEvent {
  type: "run:errored";
  reason: string;
  feature?: string;
}

/** Discriminated union of all pipeline events. */
export type PipelineEvent =
  | StoryStartedEvent
  | StoryCompletedEvent
  | StoryFailedEvent
  | VerifyCompletedEvent
  | RectifyStartedEvent
  | RectifyCompletedEvent
  | AutofixStartedEvent
  | AutofixCompletedEvent
  | RegressionDetectedEvent
  | RunCompletedEvent
  | HumanReviewRequestedEvent
  | RunStartedEvent
  | RunPausedEvent
  | StoryPausedEvent
  | RunResumedEvent
  | RunErroredEvent
  | StoryDecomposedEvent;

export type PipelineEventType = PipelineEvent["type"];

// ---------------------------------------------------------------------------
// Subscriber types
// ---------------------------------------------------------------------------

export type EventSubscriber<T extends PipelineEvent = PipelineEvent> = (event: T) => void | Promise<void>;

type SubscriberMap = Map<string, EventSubscriber[]>;

// ---------------------------------------------------------------------------
// Bus implementation
// ---------------------------------------------------------------------------

export class PipelineEventBus {
  private readonly subscribers: SubscriberMap = new Map();

  /**
   * Subscribe to a specific event type.
   *
   * @returns Unsubscribe function
   */
  on<T extends PipelineEventType>(
    eventType: T,
    subscriber: EventSubscriber<Extract<PipelineEvent, { type: T }>>,
  ): () => void {
    const list = this.subscribers.get(eventType) ?? [];
    list.push(subscriber as EventSubscriber);
    this.subscribers.set(eventType, list);

    return () => {
      const current = this.subscribers.get(eventType) ?? [];
      this.subscribers.set(
        eventType,
        current.filter((s) => s !== subscriber),
      );
    };
  }

  /**
   * Subscribe to all events.
   *
   * @returns Unsubscribe function
   */
  onAll(subscriber: EventSubscriber): () => void {
    const list = this.subscribers.get("*") ?? [];
    list.push(subscriber);
    this.subscribers.set("*", list);

    return () => {
      const current = this.subscribers.get("*") ?? [];
      this.subscribers.set(
        "*",
        current.filter((s) => s !== subscriber),
      );
    };
  }

  /**
   * Publish an event to all matching subscribers.
   *
   * Fire-and-forget: async subscribers are not awaited.
   * Subscriber errors are caught and logged — one failure doesn't block others.
   */
  emit(event: PipelineEvent): void {
    const logger = getLogger();

    const specific = this.subscribers.get(event.type) ?? [];
    const all = this.subscribers.get("*") ?? [];
    const targets = [...specific, ...all];

    for (const sub of targets) {
      try {
        const result = sub(event);
        if (result instanceof Promise) {
          result.catch((err) => {
            logger.warn("event-bus", `Subscriber error on ${event.type}`, { error: String(err) });
          });
        }
      } catch (err) {
        logger.warn("event-bus", `Subscriber threw on ${event.type}`, { error: String(err) });
      }
    }
  }

  /**
   * Publish an event and await all async subscribers.
   *
   * Use this when you need to ensure subscribers have completed before proceeding
   * (e.g., for interaction subscribers that block on human input).
   */
  async emitAsync(event: PipelineEvent): Promise<void> {
    const logger = getLogger();

    const specific = this.subscribers.get(event.type) ?? [];
    const all = this.subscribers.get("*") ?? [];
    const targets = [...specific, ...all];

    await Promise.allSettled(
      targets.map(async (sub) => {
        try {
          await sub(event);
        } catch (err) {
          logger.warn("event-bus", `Subscriber error on ${event.type}`, { error: String(err) });
        }
      }),
    );
  }

  /** Remove all subscribers (useful in tests). */
  clear(): void {
    this.subscribers.clear();
  }

  /** Number of subscribers for a given event type. */
  subscriberCount(eventType: PipelineEventType | "*"): number {
    return (this.subscribers.get(eventType) ?? []).length;
  }
}

/** Singleton pipeline event bus instance. */
export const pipelineEventBus = new PipelineEventBus();
