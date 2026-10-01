/**
 * Replay subsystem public barrel.
 *
 * Pure reconstruction core. Discovery, rendering, serialization, and CLI
 * wiring live in sibling modules.
 */

export { registerReplayCommand } from "../commands/replay";
export { type DiscoveredRun, discoverRun } from "./discovery";
export { toReplayJson } from "./json";
export { type InferredStory, inferPhases } from "./phase-infer";
export { reconstructTimeline } from "./reconstruct";
export { type RenderOptions, renderReport } from "./report";
export type { PhaseStep, ReplayInputs, RunTimeline, StoryTimeline } from "./types";
