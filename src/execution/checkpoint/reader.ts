/**
 * loadCheckpoints — durable reader for the feature-level `checkpoint.jsonl` log.
 *
 * Recovery semantics:
 * - Parse line-by-line and keep the LONGEST VALID PREFIX: a torn final line
 *   from a crash mid-append is dropped silently (it is not fatal).
 * - Keep only records whose `runId` equals the newest `runId` present in the
 *   file. Records from earlier runs are ignored — a fresh run starts clean.
 * - Group remaining records by `storyId` and order each story's `greenPhases`
 *   by canonical phase index so callers can compare against `CANONICAL_ORDER`.
 * - Skip lines that fail JSON.parse or that are missing a required field; a
 *   single bad line must not abort the parse of the rest.
 * - A missing or unreadable file yields an empty `Map` rather than throwing.
 */

import { join } from "node:path";
import { NaxError } from "@/errors";
import { CANONICAL_ORDER, type PhaseKind } from "../story-orchestrator";
import type { CheckpointReaderDeps, CheckpointRecord, StoryCheckpoint, TreeState } from "./types";

export interface LoadCheckpointsOptions {
  _deps: CheckpointReaderDeps;
}

function isValidRecord(value: unknown): value is CheckpointRecord {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  // String fields: require non-empty strings (null / undefined / wrong type / empty → invalid).
  for (const field of ["storyId", "phase", "headSha", "dirtyDigest", "runId"] as const) {
    if (typeof obj[field] !== "string" || obj[field] === "") return false;
  }
  // ts is a number (Date.now()) — reject NaN and non-numbers.
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) return false;
  // phase must be a known canonical phase — guards against null/wrong-type slipping through
  // and poisoning CANONICAL_ORDER.indexOf() (which returns -1) downstream.
  if (CANONICAL_ORDER.indexOf(obj.phase as PhaseKind) === -1) return false;
  return true;
}

function maxRunId(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

/** Default on-disk reader — Bun-native. Used when no `_deps` are supplied. */
async function defaultRead(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new NaxError(`Checkpoint log not found: ${filePath}`, "CHECKPOINT_NOT_FOUND", {
      stage: "checkpoint",
      filePath,
    });
  }
  return file.text();
}

/**
 * Load the feature-level checkpoint log into a `Map<storyId, StoryCheckpoint>`.
 *
 * The reader accepts an optional `_deps` injection point so unit tests can
 * exercise torn-line and runId-filter scenarios without depending on the
 * filesystem. Production callers (and integration tests) omit `_deps` and
 * read the real `checkpoint.jsonl` via `Bun.file().text()`.
 */
export async function loadCheckpoints(
  featureDir: string,
  options: LoadCheckpointsOptions = { _deps: { read: defaultRead } },
): Promise<Map<string, StoryCheckpoint>> {
  const filePath = join(featureDir, "checkpoint.jsonl");
  const deps = options._deps ?? { read: defaultRead };

  let content: string;
  try {
    content = await deps.read(filePath);
  } catch {
    return new Map();
  }

  const lines = content.split("\n");
  // Longest valid prefix: walk the file top-down, stop the moment a line fails
  // to parse. A torn final line is the only realistic failure mode (crash
  // mid-append), so we drop everything from the first parse failure onward.
  const validRecords: CheckpointRecord[] = [];
  for (const line of lines) {
    if (line === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isValidRecord(parsed)) continue;
      validRecords.push(parsed);
    } catch {
      break;
    }
  }

  // Newest runId (lexical max — same shape used everywhere else in the project).
  let latestRunId: string | undefined;
  for (const r of validRecords) {
    latestRunId = maxRunId(latestRunId, r.runId);
  }
  if (latestRunId === undefined) return new Map();

  // Keep only records from the latest runId.
  const latest = validRecords.filter((r) => r.runId === latestRunId);

  // Group by storyId, preserving insertion order on first-seen.
  const grouped = new Map<string, CheckpointRecord[]>();
  for (const r of latest) {
    const list = grouped.get(r.storyId);
    if (list) {
      list.push(r);
    } else {
      grouped.set(r.storyId, [r]);
    }
  }

  const result = new Map<string, StoryCheckpoint>();
  for (const [storyId, records] of grouped) {
    const seen = new Set<PhaseKind>();
    const orderedPhases: PhaseKind[] = [];
    let lastTree: TreeState = { headSha: "", dirtyDigest: "" };
    // Sort each story's records by canonical phase index so the reader is
    // stable regardless of how the file was interleaved across phases.
    records.sort((a, b) => {
      const ai = CANONICAL_ORDER.indexOf(a.phase);
      const bi = CANONICAL_ORDER.indexOf(b.phase);
      return ai - bi;
    });
    for (const r of records) {
      if (!seen.has(r.phase)) {
        seen.add(r.phase);
        orderedPhases.push(r.phase);
      }
      lastTree = { headSha: r.headSha, dirtyDigest: r.dirtyDigest };
    }
    result.set(storyId, {
      storyId,
      greenPhases: orderedPhases,
      tree: lastTree,
    });
  }
  return result;
}
