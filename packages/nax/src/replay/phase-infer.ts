/**
 * Pure phase inference from persisted log entries.
 *
 * Phase signals are reconstructed best-effort from JSONL because the clean
 * `story:step` event is bus-only and never persisted.
 *
 * This module also owns the accumulator that ingestion folds into: each log
 * record is classified once, as it arrives, and applied to every story it
 * names. Reconstruction then reads one bucket per story instead of re-filtering
 * the whole history once per story.
 */

import type { LogEntry } from "../logger/types";
import type { InferredStory, ReplayEventIndex } from "./types";

const PHASE_PASS_REGEX = /^Phase passed: (.+)$/;
const PHASE_FAIL_REGEX = /^Phase failed: (.+)$/;

function extractPhaseName(match: RegExpMatchArray): string {
  const captured = match[1];
  return captured ?? "";
}

function nestedStoryId(entry: LogEntry): string | undefined {
  const data = entry.data;
  if (!data || typeof data !== "object") return undefined;
  const nested = (data as Record<string, unknown>).storyId;
  return typeof nested === "string" ? nested : undefined;
}

/**
 * Every story ID a record names: the top-level `storyId` first, then the nested
 * `data.storyId`. Both are returned when they disagree (AC-3); a record that
 * names the same ID twice yields it once, so it is never folded in twice.
 */
function storyIdsOf(entry: LogEntry): string[] {
  const top = typeof entry.storyId === "string" ? entry.storyId : undefined;
  const nested = nestedStoryId(entry);
  if (top === undefined) {
    return nested === undefined ? [] : [nested];
  }
  if (nested === undefined || nested === top) return [top];
  return [top, nested];
}

/**
 * Discovery ID for a record — the top-level `storyId`, falling back to the
 * nested one only when the record carries no top-level ID (AC-4).
 */
function discoveryIdOf(entry: LogEntry): string | undefined {
  return typeof entry.storyId === "string" ? entry.storyId : nestedStoryId(entry);
}

/** A story bucket with no signals yet. */
function emptyStory(): InferredStory {
  return { phases: [], escalations: [], fixCycles: 0 };
}

/** Fold one record into one story's bucket — the single classification site. */
function foldIntoStory(bucket: InferredStory, entry: LogEntry): void {
  if (entry.stage === "story-orchestrator") {
    const passMatch = entry.message.match(PHASE_PASS_REGEX);
    if (passMatch) {
      bucket.phases.push({ name: extractPhaseName(passMatch), status: "pass" });
    } else {
      const failMatch = entry.message.match(PHASE_FAIL_REGEX);
      if (failMatch) bucket.phases.push({ name: extractPhaseName(failMatch), status: "fail" });
    }
    return;
  }

  if (entry.stage === "agent-manager" && entry.message.includes("fail-stale")) {
    bucket.escalations.push(entry.message);
    return;
  }

  if (entry.stage === "findings.cycle") {
    bucket.fixCycles += 1;
  }
}

function bucketFor(index: ReplayEventIndex, storyId: string): InferredStory {
  const existing = index.buckets.get(storyId);
  if (existing) return existing;
  const created = emptyStory();
  index.buckets.set(storyId, created);
  return created;
}

function recordNaxVersion(index: ReplayEventIndex, entry: LogEntry): void {
  if (index.naxVersion !== undefined || entry.stage !== "run.start") return;
  const version = entry.data?.naxVersion;
  if (typeof version === "string") index.naxVersion = version;
}

function recordDiscovery(index: ReplayEventIndex, entry: LogEntry): void {
  const id = discoveryIdOf(entry);
  if (id !== undefined) index.storyIds.add(id);
}

/** An empty accumulator — no records inspected, no stories discovered. */
export function createReplayEventIndex(): ReplayEventIndex {
  return {
    buckets: new Map<string, InferredStory>(),
    storyIds: new Set<string>(),
    naxVersion: undefined,
    recordsInspected: 0,
  };
}

/**
 * Fold one log record into the index: one full-record pass, whatever the story
 * count. Run-level records still contribute run-level context (the `naxVersion`
 * of the first `run.start` record) without creating a story bucket.
 */
export function indexEvent(index: ReplayEventIndex, entry: LogEntry): void {
  index.recordsInspected += 1;
  recordNaxVersion(index, entry);
  recordDiscovery(index, entry);
  for (const storyId of storyIdsOf(entry)) {
    foldIntoStory(bucketFor(index, storyId), entry);
  }
}

/** Build an index from records already held in memory (one pass over them). */
export function indexEvents(entries: readonly LogEntry[]): ReplayEventIndex {
  const index = createReplayEventIndex();
  for (const entry of entries) indexEvent(index, entry);
  return index;
}

/**
 * A story's accumulated phase inputs. A story with no records yields empty
 * inputs and does not add an entry to the index.
 */
export function storyInputs(index: ReplayEventIndex, storyId: string): InferredStory {
  return index.buckets.get(storyId) ?? emptyStory();
}

/**
 * Infer a story's phases, escalations, and fix-cycle iterations from log
 * entries. Pure — no I/O, no filesystem, no logger. Kept for callers holding
 * every record in memory; the streaming path builds one index and reads a
 * bucket per story instead.
 */
export function inferPhases(entries: readonly LogEntry[], storyId: string): InferredStory {
  return storyInputs(indexEvents(entries), storyId);
}
