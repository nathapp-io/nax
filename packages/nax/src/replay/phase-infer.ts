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

const PHASE_PASS_REGEX = /^Phase passed: (.+)$/;
const PHASE_FAIL_REGEX = /^Phase failed: (.+)$/;

function extractPhaseName(match: RegExpMatchArray): string {
  const captured = match[1];
  return captured ?? "";
}

function entryBelongsToStory(entry: LogEntry, storyId: string): boolean {
  if (entry.storyId === storyId) return true;
  const data = entry.data;
  if (data && typeof data === "object" && (data as Record<string, unknown>).storyId === storyId) {
    return true;
  }
  return false;
}

/**
 * Infer a story's phases, escalations, and fix-cycle iterations from log
 * entries. Pure — no I/O, no filesystem, no logger.
 */
export function inferPhases(entries: readonly LogEntry[], storyId: string): InferredStory {
  const phases: PhaseStep[] = [];
  const escalations: string[] = [];
  let fixCycles = 0;

  for (const entry of entries) {
    if (!entryBelongsToStory(entry, storyId)) continue;

    if (entry.stage === "story-orchestrator") {
      const passMatch = entry.message.match(PHASE_PASS_REGEX);
      if (passMatch) {
        phases.push({ name: extractPhaseName(passMatch), status: "pass" });
        continue;
      }
      const failMatch = entry.message.match(PHASE_FAIL_REGEX);
      if (failMatch) {
        phases.push({ name: extractPhaseName(failMatch), status: "fail" });
        continue;
      }
    }

    if (entry.stage === "agent-manager" && entry.message.includes("fail-stale")) {
      escalations.push(entry.message);
      continue;
    }

    if (entry.stage === "findings.cycle") {
      fixCycles += 1;
    }
  }

  return { phases, escalations, fixCycles };
}
