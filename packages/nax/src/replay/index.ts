/**
 * Replay subsystem public barrel.
 *
 * Pure reconstruction core. Discovery, rendering, serialization, and CLI
 * wiring live in sibling modules.
 */

export { registerReplayCommand } from "../commands/replay";
export { type DiscoveredRun, discoverRun } from "./discovery";
export { type IngestReplayLogOptions, ingestReplayLog, readReplayEvents } from "./event-stream";
export { toReplayJson } from "./json";
export { createReplayEventIndex, indexEvent, indexEvents, inferPhases, storyInputs } from "./phase-infer";
export { reconstructTimeline } from "./reconstruct";
export { type RenderOptions, renderReport } from "./report";
export type {
  InferredStory,
  PhaseStep,
  ReplayEventIndex,
  ReplayInputs,
  RunTimeline,
  StoryTimeline,
} from "./types";
