/**
 * usePipelineBusEvents hook — subscribe to the pipeline event bus and update TUI state.
 *
 * Listens to typed PipelineEventBus events (story:started, story:completed,
 * story:failed, story:skipped, story:escalated, run:completed) and updates
 * story display states, cost accumulator, elapsed time, escalation log, and
 * run summary.
 *
 * Uses setInterval (not Bun.sleep) because this is UI code that needs a
 * cancellable timer handle via clearInterval.
 */

import { useEffect, useRef, useState } from "react";
import type { RunCompletedEvent } from "../../pipeline/event-bus";
import { pipelineEventBus } from "../../pipeline/event-bus";
import type { StoryDisplayState } from "../types";

/** Entry in the escalation log. */
export interface EscalationEntry {
  storyId: string;
  fromTier: string;
  toTier: string;
  at: number;
}

/** Run summary from run:completed event. */
export interface RunSummary {
  totalStories: number;
  passedStories: number;
  failedStories: number;
  skippedStories: number;
  pausedStories: number;
  durationMs: number;
  totalCost?: number;
}

/**
 * State managed by the usePipelineBusEvents hook.
 */
export interface PipelineBusState {
  /** Story display states, updated from bus events */
  stories: StoryDisplayState[];
  /** Total cost accumulated across all stories */
  totalCost: number;
  /** Elapsed time in milliseconds since hook mount */
  elapsedMs: number;
  /** Whether the run is paused */
  runPaused: boolean;
  /** Run completion summary (set when run:completed fires) */
  runSummary?: RunSummary;
  /** Whether the run errored */
  runErrored: boolean;
  /** Log of escalation events (story:escalated) */
  escalationLog: EscalationEntry[];
}

/**
 * Hook for subscribing to the singleton pipelineEventBus and managing TUI state.
 *
 * @param initialStories - Initial story display states from the parent component
 * @returns PipelineBusState — updated in real-time as pipeline events fire
 */
export function usePipelineBusEvents(initialStories: StoryDisplayState[]): PipelineBusState {
  const [state, setState] = useState<PipelineBusState>(() => ({
    stories: initialStories,
    totalCost: 0,
    elapsedMs: 0,
    runPaused: false,
    runErrored: false,
    escalationLog: [],
  }));

  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    const startTime = startTimeRef.current;

    // Elapsed timer — runs continuously while the hook is mounted
    const timer = setInterval(() => {
      setState((prev) => ({
        ...prev,
        elapsedMs: Date.now() - startTime,
      }));
    }, 1000);

    // story:started — mark story running, capture modelTier and iteration
    const unsubStarted = pipelineEventBus.on("story:started", (event) => {
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === event.storyId
            ? {
                ...s,
                status: "running" as const,
                modelTier: event.modelTier,
                iteration: event.iteration,
              }
            : s,
        ),
      }));
    });

    // story:completed — mark story passed/failed, accumulate cost
    const unsubCompleted = pipelineEventBus.on("story:completed", (event) => {
      setState((prev) => {
        const newStories = prev.stories.map((s) => {
          if (s.story.id === event.storyId) {
            const status = event.passed ? ("passed" as const) : ("failed" as const);
            const storyCost = (s.cost ?? 0) + (event.cost ?? 0);
            return { ...s, status, cost: storyCost };
          }
          return s;
        });

        const totalCost = newStories.reduce((sum, s) => sum + (s.cost ?? 0), 0);

        return { ...prev, stories: newStories, totalCost };
      });
    });

    // story:failed — mark story failed, capture failure reason
    const unsubFailed = pipelineEventBus.on("story:failed", (event) => {
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === event.storyId
            ? {
                ...s,
                status: "failed" as const,
                failureReason: event.reason,
              }
            : s,
        ),
      }));
    });

    // story:skipped — mark story skipped
    const unsubSkipped = pipelineEventBus.on("story:skipped", (event) => {
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === event.storyId ? { ...s, status: "skipped" as const } : s,
        ),
      }));
    });

    // story:escalated — mark story retrying, append to escalation log
    const unsubEscalated = pipelineEventBus.on("story:escalated", (event) => {
      const entry: EscalationEntry = {
        storyId: event.storyId,
        fromTier: event.fromTier,
        toTier: event.toTier,
        at: Date.now(),
      };
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === event.storyId ? { ...s, status: "retrying" as const } : s,
        ),
        escalationLog: [...prev.escalationLog, entry],
      }));
    });

    // run:paused — mark run as paused
    const unsubPaused = pipelineEventBus.on("run:paused", (_event) => {
      setState((prev) => ({ ...prev, runPaused: true }));
    });

    // run:resumed — clear paused flag
    const unsubResumed = pipelineEventBus.on("run:resumed", (_event) => {
      setState((prev) => ({ ...prev, runPaused: false }));
    });

    // run:completed — set run summary and final total cost
    const unsubCompleted2 = pipelineEventBus.on("run:completed", (event: RunCompletedEvent) => {
      const summary: RunSummary = {
        totalStories: event.totalStories,
        passedStories: event.passedStories,
        failedStories: event.failedStories,
        skippedStories: event.skippedStories,
        pausedStories: event.pausedStories,
        durationMs: event.durationMs,
        totalCost: event.totalCost,
      };
      setState((prev) => ({
        ...prev,
        runSummary: summary,
        totalCost: event.totalCost ?? prev.totalCost,
      }));
    });

    // run:errored — mark run as errored
    const unsubErrored = pipelineEventBus.on("run:errored", (_event) => {
      setState((prev) => ({ ...prev, runErrored: true }));
    });

    return () => {
      clearInterval(timer);
      unsubStarted();
      unsubCompleted();
      unsubFailed();
      unsubSkipped();
      unsubEscalated();
      unsubPaused();
      unsubResumed();
      unsubCompleted2();
      unsubErrored();
    };
  }, []);

  return state;
}
