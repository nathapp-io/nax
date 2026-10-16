/**
 * result.json (spec §9): per-story state for resume and the feature report.
 * Written atomically (tmp + rename) after every phase change.
 */
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { runStateWrite } from "@/runstate/store";
import { buildVerdict } from "./open-items";
import type {
  RoleTokens,
  StoryStateItem,
  WorkflowFeatureRecord,
  WorkflowResultFile,
  WorkflowStoryRecord,
} from "./types";

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
    ...(current?.verdict ? { verdict: current.verdict } : {}),
    ...(current?.preflightTokensByRole ? { preflightTokensByRole: current.preflightTokensByRole } : {}),
  });
}

/**
 * US-004: this run's pre-flight spend, per role. Written once by `runWorkflowPreflight` — the file
 * may not exist yet, so this is also the run's first result write. Every later write keeps the field.
 */
export async function writePreflightTokens(
  runDir: string,
  header: { readonly runId: string; readonly feature: string },
  byRole: Readonly<Record<string, RoleTokens>>,
): Promise<void> {
  const current = await readResult(runDir);
  await writeResult(runDir, {
    schemaVersion: 1,
    runId: header.runId,
    feature: header.feature,
    stories: current?.stories ?? {},
    preflightTokensByRole: byRole,
    ...(current?.featureWorkflow ? { featureWorkflow: current.featureWorkflow } : {}),
    ...(current?.verdict ? { verdict: current.verdict } : {}),
  });
}

async function writeResult(runDir: string, next: WorkflowResultFile): Promise<void> {
  await _resultDeps.mkdir(runDir, { recursive: true });
  const path = join(runDir, RESULT_FILE);
  const tmp = `${path}.tmp`;
  const text = `${JSON.stringify(next, null, 2)}\n`;
  await runStateWrite(path, { content: text }, async () => {
    await Bun.write(tmp, text);
    await _resultDeps.rename(tmp, path);
  });
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

/**
 * US-002: `publishStep` writes `storyStates` from the stories it saw, so a record that has none was
 * written before that field existed (or by a caller that never published). The run's own story
 * records still name each story's end state, so the verdict reads them rather than dropping the
 * story items. An empty array is a statement of its own and is kept as it is.
 *
 * Exported for `nax workflow status` (US-003), which fills the same field from the same
 * `result.stories` before it builds the verdict (AC-5, AC-13).
 */
export function storyStatesFrom(stories: Readonly<Record<string, WorkflowStoryRecord>>): StoryStateItem[] {
  return Object.values(stories).map((s) => ({
    id: s.storyId,
    state: s.state ?? "not-run",
    ...(s.reason !== undefined ? { reason: s.reason } : {}),
  }));
}

/** Writes the feature workflow's state into this run's result.json, keeping the story records (P4-R1). */
export async function upsertFeatureRecord(
  runDir: string,
  header: { readonly runId: string; readonly feature: string },
  record: WorkflowFeatureRecord,
): Promise<void> {
  const current = await readResult(runDir);
  const filled = record.storyStates ? record : { ...record, storyStates: storyStatesFrom(current?.stories ?? {}) };
  const verdict = buildVerdict(filled);
  await writeResult(runDir, {
    schemaVersion: 1,
    runId: header.runId,
    feature: header.feature,
    stories: current?.stories ?? {},
    featureWorkflow: record,
    ...(verdict ? { verdict } : {}),
    ...(current?.preflightTokensByRole ? { preflightTokensByRole: current.preflightTokensByRole } : {}),
  });
}
