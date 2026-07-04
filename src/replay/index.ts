/**
 * Replay subsystem public barrel.
 *
 * Pure reconstruction core. Discovery, rendering, serialization, and CLI
 * wiring live in sibling modules.
 */

export { inferPhases, type InferredStory } from "./phase-infer";
export { reconstructTimeline } from "./reconstruct";
export { discoverRun, type DiscoveredRun } from "./discovery";
export { renderReport, type RenderOptions } from "./report";
export { toReplayJson } from "./json";
export { registerReplayCommand } from "../commands/replay";
export type { PhaseStep, StoryTimeline, RunTimeline, ReplayInputs } from "./types";
