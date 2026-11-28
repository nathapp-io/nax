/**
 * Pure timeline reconstruction — composes phase inference with metrics/status
 * into a single `RunTimeline` value-object.
 *
 * No I/O; the caller loads JSONL/metrics/status.json and passes the data in.
 */

import type { NaxStatusFile } from "../execution/status-file";
import { indexEvents, storyInputs } from "./phase-infer";
import type { InferredStory, ReplayEventIndex, ReplayInputs, RunTimeline, StoryTimeline } from "./types";

/**
 * Resolve the per-story index to read from: a streamed one wins; in-memory
 * records are indexed in a single pass. Either way the work is one pass per
 * record, never one pass per record per story.
 */
function resolveEvents(inputs: ReplayInputs): ReplayEventIndex {
  return inputs.events ?? indexEvents(inputs.entries ?? []);
}

/**
 * Maps a status.json run status to the degrade-path RunTimeline status when
 * no RunMetrics entry exists. Any terminal non-success status (not just
 * "crashed") means the run never wrote its metrics, so the report must
 * degrade rather than default to a misleading "completed".
 */
function degradedRunStatus(status: NaxStatusFile["run"]["status"] | undefined): RunTimeline["status"] | undefined {
  switch (status) {
    case "crashed":
      return "crashed";
    case "failed":
    case "stalled":
    case "precheck-failed":
      return "failed";
    default:
      return undefined;
  }
}

interface StoryMetricsView {
  success: boolean;
  finalTier: string;
  cost: number;
  attempts: number;
  includeCost: boolean;
}

function buildStoryFromMetrics(storyId: string, story: InferredStory, metrics: StoryMetricsView): StoryTimeline {
  const { success, finalTier, cost, attempts, includeCost } = metrics;
  const status: StoryTimeline["status"] = includeCost ? (success ? "passed" : "failed") : "crashed";

  const result: StoryTimeline = {
    storyId,
    status,
    phases: story.phases,
    escalations: story.escalations,
  };

  if (includeCost) {
    result.finalTier = finalTier;
    result.cost = cost;
    result.attempts = attempts;
  }

  if (story.fixCycles > 0) {
    result.fixCycles = story.fixCycles;
  }

  if (status === "failed") {
    const failedIndex = story.phases.findIndex((p) => p.status === "fail");
    if (failedIndex >= 0) {
      result.rootCausePhaseIndex = failedIndex;
    }
  }

  return result;
}

/**
 * Build a `RunTimeline` from a per-story event index (or in-memory records) plus
 * optional metrics and status.json. Pure — does not touch the filesystem or
 * read env vars.
 *
 * Each story reads its own accumulated bucket; the record spine is never
 * re-filtered, so a 100-story run costs the same record passes as a 1-story run.
 */
export function reconstructTimeline(inputs: ReplayInputs): RunTimeline {
  const runMetrics = inputs.runMetrics;
  const statusFile = inputs.status;
  const meta = inputs.meta;
  const events = resolveEvents(inputs);

  const degradedStatus = runMetrics ? undefined : degradedRunStatus(statusFile?.run.status);

  const stories: StoryTimeline[] = [];
  let runStatus: RunTimeline["status"] = "completed";

  if (runMetrics) {
    runStatus = runMetrics.storiesFailed > 0 ? "failed" : "completed";

    for (const sm of runMetrics.stories) {
      const inferred = storyInputs(events, sm.storyId);
      stories.push(
        buildStoryFromMetrics(sm.storyId, inferred, {
          success: sm.success,
          finalTier: sm.finalTier,
          cost: sm.cost,
          attempts: sm.attempts,
          includeCost: true,
        }),
      );
    }
  } else if (degradedStatus !== undefined) {
    runStatus = degradedStatus;
    for (const id of events.storyIds) {
      stories.push(
        buildStoryFromMetrics(id, storyInputs(events, id), {
          success: false,
          finalTier: "",
          cost: 0,
          attempts: 0,
          includeCost: false,
        }),
      );
    }
  }

  const timeline: RunTimeline = {
    runId: runMetrics?.runId ?? meta?.runId ?? "",
    feature: meta?.feature ?? runMetrics?.feature ?? "",
    status: runStatus,
    inferred: true,
    stories,
  };

  if (events.naxVersion !== undefined) {
    timeline.naxVersion = events.naxVersion;
  }

  return timeline;
}
