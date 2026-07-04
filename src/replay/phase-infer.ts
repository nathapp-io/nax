/**
 * Pure phase inference from persisted log entries.
 *
 * Phase signals are reconstructed best-effort from JSONL because the clean
 * `story:step` event is bus-only and never persisted. Caller filters by
 * `storyId` so this layer stays oblivious to story discovery.
 */

import type { LogEntry } from "../logger/types";
import type { PhaseStep } from "./types";

export interface InferredStory {
  phases: PhaseStep[];
  escalations: string[];
  fixCycles: number;
}

/**
 * Infer a story's phases, escalations, and fix-cycle iterations from log
 * entries. Pure — no I/O, no filesystem, no logger.
 */
export function inferPhases(entries: readonly LogEntry[], storyId: string): InferredStory {
  throw new Error("inferPhases not implemented"); // nax-lint-allow: plain-error — stub; implementer replaces with real phase inference.
}
