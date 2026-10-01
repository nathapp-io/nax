/**
 * Pipeline Event Emitter
 *
 * Typed event emitter for TUI integration. Emits lifecycle events during
 * pipeline execution so the TUI can display real-time progress.
 */

import { EventEmitter } from "node:events";
import type { UserStory } from "../prd/types";
import type { RoutingResult, StageResult } from "./types";

/**
 * Summary of a completed run.
 */
export interface RunSummary {
  /** Total number of stories processed */
  storiesProcessed: number;
  /** Number of stories completed successfully */
  storiesCompleted: number;
  /** Number of stories failed */
  storiesFailed: number;
  /** Number of stories skipped */
  storiesSkipped: number;
  /** Total cost in USD */
  totalCost: number;
  /** Total duration in milliseconds */
  durationMs: number;
}

/**
 * Pipeline event types matching v0.6 spec.
 *
 * Events:
 * - story:start — Story execution begins
 * - story:complete — Story execution ends (success/fail/skip)
 * - story:escalate — Story escalated to higher tier
 * - stage:enter — Pipeline stage starts
 * - stage:exit — Pipeline stage finishes
 * - run:complete — Full run completes
 */
export interface PipelineEvents {
  "story:start": (story: UserStory, routing: RoutingResult) => void;
  "story:complete": (story: UserStory, result: StageResult) => void;
  "story:escalate": (story: UserStory, fromTier: string, toTier: string) => void;
  "stage:enter": (stage: string, story: UserStory) => void;
  "stage:exit": (stage: string, result: StageResult) => void;
  "run:complete": (summary: RunSummary) => void;
}

/**
 * Typed event emitter for pipeline events.
 *
 * Wraps Node.js EventEmitter with TypeScript types for pipeline lifecycle
 * events. The TUI subscribes to these events to update UI state in real-time.
 *
 * @example
 * ```ts
 * const emitter = new PipelineEventEmitter();
 *
 * emitter.on('story:start', (story, routing) => {
 *   // Handle story start: ${story.id} with ${routing.modelTier}
 * });
 *
 * emitter.on('story:complete', (story, result) => {
 *   // Handle story completion: ${story.id} - ${result.action}
 * });
 *
 * // In pipeline runner:
 * emitter.emit('story:start', story, routing);
 * ```
 */
export class PipelineEventEmitter {
  private emitter = new EventEmitter();

  /**
   * Subscribe to a pipeline event.
   *
   * @param event - Event name
   * @param listener - Event handler
   */
  on<E extends keyof PipelineEvents>(event: E, listener: PipelineEvents[E]): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  /**
   * Subscribe to an event once (auto-unsubscribe after first emission).
   *
   * @param event - Event name
   * @param listener - Event handler
   */
  once<E extends keyof PipelineEvents>(event: E, listener: PipelineEvents[E]): void {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
  }

  /**
   * Unsubscribe from an event.
   *
   * @param event - Event name
   * @param listener - Event handler to remove
   */
  off<E extends keyof PipelineEvents>(event: E, listener: PipelineEvents[E]): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  /**
   * Emit a pipeline event.
   *
   * Called internally by the pipeline runner. External code should only
   * subscribe to events, not emit them.
   *
   * @param event - Event name
   * @param args - Event arguments
   */
  emit<E extends keyof PipelineEvents>(event: E, ...args: Parameters<PipelineEvents[E]>): void {
    this.emitter.emit(event, ...args);
  }

  /**
   * Remove all listeners for a specific event or all events.
   *
   * @param event - Optional event name (if not provided, removes all listeners)
   */
  removeAllListeners(event?: keyof PipelineEvents): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }
}
