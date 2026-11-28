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
import type { RunMetrics } from "../metrics/types";

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

/** Accumulated phase inputs for one story — what phase inference reads back. */
export interface InferredStory {
  phases: PhaseStep[];
  escalations: string[];
  fixCycles: number;
}

/**
 * Per-story phase inputs accumulated in one pass over the log spine.
 *
 * Ingestion folds each record into this index as it streams in; reconstruction
 * then reads one bucket per story. The story count therefore never multiplies
 * the number of record inspections.
 */
export interface ReplayEventIndex {
  /** Accumulated inputs, keyed by every story ID a record names (top-level and nested). */
  buckets: Map<string, InferredStory>;
  /** Discovered story IDs, first-seen order; the top-level ID wins over a nested one. */
  storyIds: Set<string>;
  /** `naxVersion` of the first `run.start` record that carries one. */
  naxVersion: string | undefined;
  /** Full-record passes performed — record visits, not wall-clock (the ingestion cost). */
  recordsInspected: number;
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
  /**
   * Parsed log spine, for callers that already hold every record in memory.
   * Indexed in one pass and used only when `events` is absent.
   */
  entries?: LogEntry[];
  /**
   * Pre-accumulated per-story index from the streaming reader. Takes precedence
   * over `entries`: it is the path that keeps ingestion to one pass per record.
   */
  events?: ReplayEventIndex;
  /** Matching `RunMetrics` row, if available (absent on crashed runs). */
  runMetrics?: RunMetrics;
  /** `status.json` snapshot, used to detect crashed runs without metrics. */
  status?: NaxStatusFile;
  /** Registry metadata for the run (`runId`, `feature`, etc.). */
  meta?: { runId: string; feature: string };
}
