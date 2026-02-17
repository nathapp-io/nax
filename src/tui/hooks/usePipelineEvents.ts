/**
 * usePipelineEvents hook — subscribe to pipeline events and update TUI state.
 *
 * Listens to pipeline lifecycle events and updates story display states,
 * cost accumulator, and current stage information.
 */

import { useState, useEffect } from "react";
import type { PipelineEventEmitter, RunSummary } from "../../pipeline/events";
import type { StoryDisplayState } from "../types";
import type { UserStory } from "../../prd/types";

/**
 * Pipeline state managed by the hook.
 */
export interface PipelineState {
  /** Story display states */
  stories: StoryDisplayState[];
  /** Current story being executed */
  currentStory?: UserStory;
  /** Current pipeline stage */
  currentStage?: string;
  /** Total cost accumulated */
  totalCost: number;
  /** Elapsed time in milliseconds */
  elapsedMs: number;
  /** Run completion summary (if run finished) */
  summary?: RunSummary;
}

/**
 * Hook for subscribing to pipeline events.
 *
 * @param events - Pipeline event emitter
 * @param initialStories - Initial story list from PRD
 * @returns Pipeline state updated by events
 *
 * @example
 * ```tsx
 * const emitter = new PipelineEventEmitter();
 * const state = usePipelineEvents(emitter, prd.userStories);
 *
 * return <StoriesPanel stories={state.stories} />;
 * ```
 */
export function usePipelineEvents(
  events: PipelineEventEmitter,
  initialStories: UserStory[],
): PipelineState {
  const [state, setState] = useState<PipelineState>(() => ({
    stories: initialStories.map((story) => ({
      story,
      status: story.passes ? "passed" : "pending",
      routing: story.routing,
      cost: 0,
    })),
    totalCost: 0,
    elapsedMs: 0,
  }));

  const startTime = Date.now();

  useEffect(() => {
    // Update elapsed time every second
    const timer = setInterval(() => {
      setState((prev) => ({
        ...prev,
        elapsedMs: Date.now() - startTime,
      }));
    }, 1000);

    // story:start — Mark story as running
    const onStoryStart = (story: UserStory) => {
      setState((prev) => ({
        ...prev,
        currentStory: story,
        stories: prev.stories.map((s) =>
          s.story.id === story.id ? { ...s, status: "running" as const } : s,
        ),
      }));
    };

    // story:complete — Mark story as complete (passed/failed/skipped)
    const onStoryComplete = (story: UserStory, result: { action: string }) => {
      setState((prev) => {
        const newStories = prev.stories.map((s) => {
          if (s.story.id === story.id) {
            let status: StoryDisplayState["status"] = "pending";
            if (result.action === "continue") {
              status = "passed";
            } else if (result.action === "fail") {
              status = "failed";
            } else if (result.action === "skip") {
              status = "skipped";
            } else if (result.action === "pause") {
              status = "paused";
            }

            return { ...s, status };
          }
          return s;
        });

        return {
          ...prev,
          stories: newStories,
          currentStory: undefined,
        };
      });
    };

    // story:escalate — Mark story as retrying
    const onStoryEscalate = (story: UserStory) => {
      setState((prev) => ({
        ...prev,
        stories: prev.stories.map((s) =>
          s.story.id === story.id ? { ...s, status: "retrying" as const } : s,
        ),
      }));
    };

    // stage:enter — Update current stage
    const onStageEnter = (stage: string) => {
      setState((prev) => ({
        ...prev,
        currentStage: stage,
      }));
    };

    // run:complete — Update final summary
    const onRunComplete = (summary: RunSummary) => {
      setState((prev) => ({
        ...prev,
        totalCost: summary.totalCost,
        summary,
      }));
    };

    events.on("story:start", onStoryStart);
    events.on("story:complete", onStoryComplete);
    events.on("story:escalate", onStoryEscalate);
    events.on("stage:enter", onStageEnter);
    events.on("run:complete", onRunComplete);

    return () => {
      clearInterval(timer);
      events.off("story:start", onStoryStart);
      events.off("story:complete", onStoryComplete);
      events.off("story:escalate", onStoryEscalate);
      events.off("stage:enter", onStageEnter);
      events.off("run:complete", onRunComplete);
    };
  }, [events, startTime]);

  return state;
}
