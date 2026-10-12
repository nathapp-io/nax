/**
 * result.json (spec §9): per-story state for resume and the feature report.
 * Written atomically (tmp + rename) after every phase change.
 */
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { WorkflowFeatureRecord, WorkflowResultFile, WorkflowStoryRecord } from "./types";

export const _resultDeps = { mkdir, readdir, rename, stat };

const RESULT_FILE = "result.json";

export function newStoryRecord(storyId: string, maxRounds: number, now: string): WorkflowStoryRecord {
  return {
    storyId,
    round: 0,
    maxRounds,
    phase: "implement",
    reviewed: false,
    unreviewed: false,
    openFindings: [],
    nextFindingId: 1,
    deferredMinors: 0,
    rulings: 0,
    gates: {},
    timings: {},
    startedAt: now,
  };
}

export async function readResult(runDir: string): Promise<WorkflowResultFile | null> {
  const file = Bun.file(join(runDir, RESULT_FILE));
  if (!(await file.exists())) return null;
  try {
    const parsed = (await file.json()) as WorkflowResultFile;
    return parsed?.schemaVersion === 1 && typeof parsed.stories === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function upsertStoryRecord(
  runDir: string,
  header: { readonly runId: string; readonly feature: string },
  record: WorkflowStoryRecord,
): Promise<void> {
  const current = await readResult(runDir);
  await writeResult(runDir, {
    schemaVersion: 1,
    runId: header.runId,
    feature: header.feature,
    stories: { ...(current?.stories ?? {}), [record.storyId]: record },
    ...(current?.featureWorkflow ? { featureWorkflow: current.featureWorkflow } : {}),
  });
}

async function writeResult(runDir: string, next: WorkflowResultFile): Promise<void> {
  await _resultDeps.mkdir(runDir, { recursive: true });
  const tmp = join(runDir, `${RESULT_FILE}.tmp`);
  await Bun.write(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await _resultDeps.rename(tmp, join(runDir, RESULT_FILE));
}

/**
 * The story's record from the most recent OTHER run of this feature, when that run
 * left it unfinished (no end state). Used to resume after a crash (spec §10).
 */
export async function loadPriorStoryRecord(
  featureDir: string,
  currentRunId: string,
  storyId: string,
): Promise<WorkflowStoryRecord | null> {
  return (await loadPriorStory(featureDir, currentRunId, storyId))?.record ?? null;
}

/** Same lookup as loadPriorStoryRecord, plus the prior run directory (its brief.md / report.md live there). */
export async function loadPriorStory(
  featureDir: string,
  currentRunId: string,
  storyId: string,
): Promise<{ readonly record: WorkflowStoryRecord; readonly runDir: string } | null> {
  for (const runDir of await runDirsNewestFirst(featureDir)) {
    if (basename(runDir) === currentRunId) continue;
    const record = (await readResult(runDir))?.stories[storyId];
    if (!record) continue;
    return record.state === undefined ? { record, runDir } : null;
  }
  return null;
}

/** Run dirs of a feature that hold a result.json, newest result.json first. */
export async function runDirsNewestFirst(featureDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await _resultDeps.readdir(featureDir);
  } catch {
    return [];
  }
  const dated: { runDir: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    const runDir = join(featureDir, name);
    try {
      dated.push({ runDir, mtimeMs: (await _resultDeps.stat(join(runDir, RESULT_FILE))).mtimeMs });
    } catch {
      // not a run dir, or no result.json yet
    }
  }
  return [...dated].sort((a, b) => b.mtimeMs - a.mtimeMs).map((d) => d.runDir);
}

/** Writes the feature workflow's state into this run's result.json, keeping the story records (P4-R1). */
export async function upsertFeatureRecord(
  runDir: string,
  header: { readonly runId: string; readonly feature: string },
  record: WorkflowFeatureRecord,
): Promise<void> {
  const current = await readResult(runDir);
  await writeResult(runDir, {
    schemaVersion: 1,
    runId: header.runId,
    feature: header.feature,
    stories: current?.stories ?? {},
    featureWorkflow: record,
  });
}
