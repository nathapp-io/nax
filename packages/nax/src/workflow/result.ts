/**
 * result.json (spec §9): per-story state for resume and the feature report.
 * Written atomically (tmp + rename) after every phase change.
 */
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowResultFile, WorkflowStoryRecord } from "./types";

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
  const next: WorkflowResultFile = {
    schemaVersion: 1,
    runId: header.runId,
    feature: header.feature,
    stories: { ...(current?.stories ?? {}), [record.storyId]: record },
  };
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
  let entries: string[];
  try {
    entries = await _resultDeps.readdir(featureDir);
  } catch {
    return null;
  }
  const dated: { runDir: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (name === currentRunId) continue;
    const runDir = join(featureDir, name);
    try {
      const s = await _resultDeps.stat(join(runDir, RESULT_FILE));
      dated.push({ runDir, mtimeMs: s.mtimeMs });
    } catch {
      // not a run dir, or no result.json yet
    }
  }
  dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const { runDir } of dated) {
    const record = (await readResult(runDir))?.stories[storyId];
    if (!record) continue;
    return record.state === undefined ? record : null;
  }
  return null;
}
