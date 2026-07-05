/**
 * Replay reconstruction core — pure types
 *
 * The replay subsystem reads persisted JSONL + metrics + status.json and
 * reconstructs a `RunTimeline` for the `nax replay` post-mortem command.
 * The reconstruction core is pure: it has no filesystem or process I/O.
 *
 * Phases are **inferred** from log lines because the clean `story:step`
 * event is bus-only and never persisted — replay should never claim
 * authoritativeness that the source data does not support.
 */

import type { NaxStatusFile } from "../execution/status-file";
import type { LogEntry } from "../logger/types";
import type { RunMetrics, StoryMetrics } from "../metrics/types";

/** A single inferred phase step reconstructed from a "Phase passed/failed" log line. */
export interface PhaseStep {
  name: string;
  status: "pass" | "fail";
}

/** Inferred reconstruction for a single story in the run. */
export interface StoryTimeline {
  storyId: string;
  status: "passed" | "failed" | "crashed";
  finalTier?: string;
  cost?: number;
  attempts?: number;
  phases: PhaseStep[];
  escalations: string[];
  fixCycles?: number;
  rootCausePhaseIndex?: number;
}

/** Reconstructed timeline for an entire nax run. */
export interface RunTimeline {
  runId: string;
  feature: string;
  status: "completed" | "crashed" | "failed";
  inferred: true;
  naxVersion?: string;
  stories: StoryTimeline[];
}

/** Inputs accepted by `reconstructTimeline`. Pure data — no I/O. */
export interface ReplayInputs {
  /** Parsed log spine (already read from JSONL by the caller). */
  entries: LogEntry[];
  /** Matching `RunMetrics` row, if available (absent on crashed runs). */
  runMetrics?: RunMetrics;
  /** `status.json` snapshot, used to detect crashed runs without metrics. */
  status?: NaxStatusFile;
  /** Registry metadata for the run (`runId`, `feature`, etc.). */
  meta?: { runId: string; feature: string };
}
