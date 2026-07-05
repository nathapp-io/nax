/**
 * Pure timeline reconstruction — composes phase inference with metrics/status
 * into a single `RunTimeline` value-object.
 *
 * No I/O; the caller loads JSONL/metrics/status.json and passes the data in.
 */

import type { NaxStatusFile } from "../execution/status-file";
import { inferPhases } from "./phase-infer";
import type { ReplayInputs, RunTimeline, StoryTimeline } from "./types";

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

function extractNaxVersion(entries: ReplayInputs["entries"]): string | undefined {
  for (const entry of entries) {
    if (entry.stage === "run.start") {
      const version = entry.data?.naxVersion;
      if (typeof version === "string") return version;
    }
  }
  return undefined;
}

interface StoryMetricsView {
  success: boolean;
  finalTier: string;
  cost: number;
  attempts: number;
  includeCost: boolean;
}

function buildStoryFromMetrics(
  storyId: string,
  story: ReturnType<typeof inferPhases>,
  metrics: StoryMetricsView,
): StoryTimeline {
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
 * Build a `RunTimeline` from parsed log entries + optional metrics and
 * status.json. Pure — does not touch the filesystem or read env vars.
 */
export function reconstructTimeline(inputs: ReplayInputs): RunTimeline {
  const runMetrics = inputs.runMetrics;
  const statusFile = inputs.status;
  const meta = inputs.meta;

  const degradedStatus = runMetrics ? undefined : degradedRunStatus(statusFile?.run.status);

  const stories: StoryTimeline[] = [];
  let runStatus: RunTimeline["status"] = "completed";

  if (runMetrics) {
    runStatus = runMetrics.storiesFailed > 0 ? "failed" : "completed";

    for (const sm of runMetrics.stories) {
      const inferred = inferPhases(inputs.entries, sm.storyId);
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
    const seen = new Set<string>();
    for (const entry of inputs.entries) {
      const id = entry.storyId ?? (entry.data?.storyId as string | undefined);
      if (typeof id !== "string") continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const inferred = inferPhases(inputs.entries, id);
      stories.push(
        buildStoryFromMetrics(id, inferred, {
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

  const naxVersion = extractNaxVersion(inputs.entries);
  if (naxVersion !== undefined) {
    timeline.naxVersion = naxVersion;
  }

  return timeline;
}
