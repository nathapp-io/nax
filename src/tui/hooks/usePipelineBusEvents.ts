/**
 * usePipelineBusEvents hook — subscribe to the pipeline event bus and update TUI state.
 *
 * Listens to typed PipelineEventBus events (story:started, story:completed,
 * story:failed, story:skipped, story:escalated, run:completed, postrun:phase:*)
 * and updates story display states, cost accumulator, post-run phase states,
 * escalation log, and run summary.
 *
 * Elapsed time is intentionally NOT tracked here — it lives in App.tsx as a
 * separate useState so the 1s timer doesn't cause story/activity panels to re-render.
 */

import { pipelineEventBus } from "@/pipeline";
import type { RunCompletedEvent } from "@/pipeline";
import { useEffect, useState } from "react";
import type { StoryDisplayState } from "../types";

/** Entry in the escalation log. */
export interface EscalationEntry {
  storyId: string;
  fromTier: string;
  toTier: string;
  at: number;
}

/**
 * MEM-2: cap on the escalation log. Only the newest entries are kept — a long
 * run with many escalations must not grow the array for its whole lifetime
 * (the display already shows at most this many, so nothing is lost).
 */
const MAX_ESCALATION_LOG_ENTRIES = 5;

/** Run summary from run:completed event. Export for consumers (e.g. LiveActivityPanel). */
export interface RunSummary {
  totalStories: number;
  passedStories: number;
  failedStories: number;
  skippedStories: number;
  pausedStories: number;
  durationMs: number;
  totalCost?: number;
}

/** Status of a single post-run phase (acceptance, regression, or deferred review). */
export interface PostRunPhaseState {
  status: "running" | "passed" | "failed";
}

/**
 * State managed by the usePipelineBusEvents hook.
 */
export interface PipelineBusState {
  /** Story display states, updated from bus events */
  stories: StoryDisplayState[];
  /** Total cost accumulated across all stories */
  totalCost: number;
  /** Whether the run is paused */
  runPaused: boolean;
  /** Run completion summary (set when run:completed fires) */
  runSummary?: RunSummary;
  /** Whether the run errored */
  runErrored: boolean;
  /** Log of escalation events (story:escalated) */
  escalationLog: EscalationEntry[];
  /** Current orchestrator step per story (e.g. "test-writer", "implementer", "verifier") */
  storySteps: Record<string, string>;
  /** Post-run phase statuses (acceptance, acceptance-setup, regression, review, finish) */
  postRunPhases: {
    acceptance?: PostRunPhaseState;
    "acceptance-setup"?: PostRunPhaseState;
    regression?: PostRunPhaseState;
    review?: PostRunPhaseState;
    finish?: PostRunPhaseState;
  };
  /**
   * Id of the most recently failed story — target for the TUI "retry last failed" (r) key.
   * Single-slot by design: only the latest terminal failure is retryable, so in parallel
   * mode an earlier concurrent failure is not reachable via `r`.
   */
  lastFailedStoryId?: string;
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
    runPaused: false,
    runErrored: false,
    escalationLog: [],
    storySteps: {},
    postRunPhases: {},
  }));

  useEffect(() => {
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
        // Once the last-failed story restarts, its failure is stale — clear the
        // retry target. A fresh failure re-arms it via the story:failed handler.
        lastFailedStoryId: prev.lastFailedStoryId === event.storyId ? undefined : prev.lastFailedStoryId,
      }));
    });

    // story:completed — mark story passed/failed, set cost, clear step
    const unsubCompleted = pipelineEventBus.on("story:completed", (event) => {
      setState((prev) => {
        // Add this completion's cost onto the story's running total instead of
        // replacing it — a story that completes more than once (e.g. a retried
        // attempt) would otherwise have its earlier attempt's cost silently
        // dropped the moment the later cost overwrites it (BUG-55: "a $0.50 then
        // $0.30 story" ends up contributing only $0.30 to the running total).
        // A no-op for the common single-completion case (prevStoryCost is 0).
        const prevStoryCost = prev.stories.find((s) => s.story.id === event.storyId)?.cost ?? 0;
        const costDelta = event.cost ?? 0;
        const storyCost = prevStoryCost + costDelta;
        const totalCost = prev.totalCost + costDelta;
        const newStories = prev.stories.map((s) => {
          if (s.story.id === event.storyId) {
            const status = event.passed ? ("passed" as const) : ("failed" as const);
            return { ...s, status, cost: storyCost };
          }
          return s;
        });

        const { [event.storyId]: _removed, ...remainingSteps } = prev.storySteps;
        // Mirror the status mapping above: a `passed:false` completion is a failure,
        // so it arms the retry target too. In practice terminal failures arrive via
        // `story:failed`; this branch keeps the two failure representations consistent.
        const lastFailedStoryId = event.passed ? prev.lastFailedStoryId : event.storyId;

        return { ...prev, stories: newStories, totalCost, storySteps: remainingSteps, lastFailedStoryId };
      });
    });

    // story:failed — mark story failed, capture failure reason, clear step
    const unsubFailed = pipelineEventBus.on("story:failed", (event) => {
      setState((prev) => {
        const { [event.storyId]: _removed, ...remainingSteps } = prev.storySteps;
        return {
          ...prev,
          stories: prev.stories.map((s) =>
            s.story.id === event.storyId ? { ...s, status: "failed" as const, failureReason: event.reason } : s,
          ),
          storySteps: remainingSteps,
          lastFailedStoryId: event.storyId,
        };
      });
    });

    // story:skipped — mark story skipped
    const unsubSkipped = pipelineEventBus.on("story:skipped", (event) => {
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) => (s.story.id === event.storyId ? { ...s, status: "skipped" as const } : s)),
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
        stories: prev.stories.map((s) => (s.story.id === event.storyId ? { ...s, status: "retrying" as const } : s)),
        escalationLog: [...prev.escalationLog, entry].slice(-MAX_ESCALATION_LOG_ENTRIES),
      }));
    });

    // story:paused — mark individual story as paused
    const unsubStoryPaused = pipelineEventBus.on("story:paused", (event) => {
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === event.storyId ? { ...s, status: "paused" as const, failureReason: event.reason } : s,
        ),
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
        // Run is over — the runner no longer polls the queue file, so a retry
        // would be a silent no-op. Disarm the "r" key.
        lastFailedStoryId: undefined,
      }));
    });

    // run:errored — mark run as errored
    const unsubErrored = pipelineEventBus.on("run:errored", (_event) => {
      setState((prev) => ({ ...prev, runErrored: true }));
    });

    // story:step — update current orchestrator step for a story
    const unsubStep = pipelineEventBus.on("story:step", (event) => {
      setState((prev) => ({
        ...prev,
        storySteps: { ...prev.storySteps, [event.storyId]: event.step },
      }));
    });

    // postrun:phase:started — mark phase as running
    const unsubPostRunStarted = pipelineEventBus.on("postrun:phase:started", (event) => {
      setState((prev) => ({
        ...prev,
        postRunPhases: { ...prev.postRunPhases, [event.phase]: { status: "running" } },
      }));
    });

    // postrun:phase:completed — mark phase as passed/failed
    const unsubPostRunCompleted = pipelineEventBus.on("postrun:phase:completed", (event) => {
      setState((prev) => ({
        ...prev,
        postRunPhases: {
          ...prev.postRunPhases,
          [event.phase]: { status: event.passed ? "passed" : "failed" },
        },
      }));
    });

    return () => {
      unsubStarted();
      unsubCompleted();
      unsubFailed();
      unsubSkipped();
      unsubEscalated();
      unsubStoryPaused();
      unsubPaused();
      unsubResumed();
      unsubCompleted2();
      unsubErrored();
      unsubStep();
      unsubPostRunStarted();
      unsubPostRunCompleted();
    };
  }, []);

  return state;
}
