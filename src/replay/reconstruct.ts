/**
 * Pure timeline reconstruction — composes phase inference with metrics/status
 * into a single `RunTimeline` value-object.
 *
 * No I/O; the caller loads JSONL/metrics/status.json and passes the data in.
 */

import { inferPhases } from "./phase-infer";
import type { ReplayInputs, RunTimeline, StoryTimeline } from "./types";

function extractNaxVersion(entries: ReplayInputs["entries"]): string | undefined {
  for (const entry of entries) {
    if (entry.stage === "run.start") {
      const version = entry.data?.naxVersion;
      if (typeof version === "string") return version;
    }
  }
  return undefined;
}

function buildStoryFromMetrics(
  storyId: string,
  story: ReturnType<typeof inferPhases>,
  success: boolean,
  finalTier: string,
  cost: number,
  attempts: number,
  includeCost: boolean,
): StoryTimeline {
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

  const isCrashed = !runMetrics && statusFile?.run.status === "crashed";

  const stories: StoryTimeline[] = [];
  let runStatus: RunTimeline["status"] = "completed";

  if (runMetrics) {
    runStatus = runMetrics.storiesFailed > 0 ? "failed" : "completed";

    for (const sm of runMetrics.stories) {
      const inferred = inferPhases(inputs.entries, sm.storyId);
      stories.push(buildStoryFromMetrics(sm.storyId, inferred, sm.success, sm.finalTier, sm.cost, sm.attempts, true));
    }
  } else if (isCrashed) {
    runStatus = "crashed";
    const seen = new Set<string>();
    for (const entry of inputs.entries) {
      const id = entry.storyId ?? (entry.data?.storyId as string | undefined);
      if (typeof id !== "string") continue;
      if (seen.has(id)) continue;
      seen.add(id);
      const inferred = inferPhases(inputs.entries, id);
      stories.push(buildStoryFromMetrics(id, inferred, false, "", 0, 0, false));
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
