/**
 * Replay timeline → JSON serializer.
 *
 * Pure, value-only: consumes a `RunTimeline` and produces a plain object
 * suitable for `JSON.stringify`. All optional `StoryTimeline` fields are
 * passed through unchanged.
 */

import type { RunTimeline } from "./types";

/**
 * Serialize a `RunTimeline` to a plain JSON-friendly object.
 *
 * The shape mirrors `RunTimeline` directly so callers can re-hydrate it
 * trivially. No metadata stripping, no field renaming — the on-the-wire
 * format is the in-memory format.
 */
export function toReplayJson(timeline: RunTimeline): RunTimeline {
  return {
    runId: timeline.runId,
    feature: timeline.feature,
    status: timeline.status,
    inferred: timeline.inferred,
    stories: timeline.stories,
    ...(timeline.naxVersion !== undefined ? { naxVersion: timeline.naxVersion } : {}),
  };
}
