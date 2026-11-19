/**
 * result.json (spec §9): per-story state for resume and the feature report.
 * Written atomically (tmp + rename) after every phase change.
 */
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { withFileLock } from "@nathapp/nax-agent/internal";
import { activeKeepers, runStateWrite } from "@/runstate/store";
import { writeStagedFile } from "./atomic-write";
import { runAsHandoffLockHolder } from "./handoff-lock-owner";
import { buildVerdict } from "./open-items";
import { HANDOFF_RESULT_LOCK_WAIT_MS, handoffLockPath } from "./paths";
import { restorePendingResults } from "./result-recovery";
import type {
  RoleTokens,
  StoryStateItem,
  WorkflowFeatureRecord,
  WorkflowResultFile,
  WorkflowStoryRecord,
} from "./types";

export const _resultDeps = { mkdir, open, readdir, rename, stat, unlink };

const RESULT_FILE = "result.json";

type ResultHeader = { readonly runId: string; readonly feature: string };

/**
 * Under the feature's handoff lock. A run-end or crash repair cannot wait for a holder outside the run's
 * call tree, so it keeps a damaged result's good copy in `result.recovery.json` instead (#2984); this
 * lock-take is where those copies are replayed, before `task` reads the result it would merge into.
 */
async function withResultLock<T>(runDir: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const featureDir = dirname(runDir);
  await _resultDeps.mkdir(featureDir, { recursive: true });
  return await withFileLock(
    handoffLockPath(featureDir),
    async () => {
      await restorePendingResults(featureDir);
      return await task();
    },
    {
      lockName: "handoff",
      errorPrefix: "[workflow]",
      timeoutMs: HANDOFF_RESULT_LOCK_WAIT_MS,
      signal,
    },
  );
}

export type LockedFeatureWriter = (record: WorkflowFeatureRecord) => Promise<void>;

/**
 * A publisher holds the lock across its checks, publication and result writes. Its own call tree is
 * marked as the holder, so a run-state repair inside it (a CI-repair turn) restores the result under
 * this hold instead of deferring to it.
 */
export function withLockedFeatureResult<T>(
  target: ResultHeader & { readonly runDir: string },
  task: (write: LockedFeatureWriter) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const lockPath = handoffLockPath(dirname(target.runDir));
  return withResultLock(
    target.runDir,
    () => runAsHandoffLockHolder(lockPath, () => task((record) => writeFeatureRecord(target.runDir, target, record))),
    signal,
  );
}

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

function parseResult(text: string): WorkflowResultFile | null {
  try {
    const parsed = JSON.parse(text) as WorkflowResultFile;
    return parsed?.schemaVersion === 1 && typeof parsed.stories === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function readResult(runDir: string): Promise<WorkflowResultFile | null> {
  const file = Bun.file(join(runDir, RESULT_FILE));
  if (!(await file.exists())) return null;
  try {
    return parseResult(await file.text());
  } catch {
    return null;
  }
}

/**
 * Under the handoff lock, merge from the checkpoint nax last recorded for this exact path.
 * Turn repair can defer while another process holds the lock, leaving damaged bytes on disk.
 */
function readResultForUpdate(runDir: string): Promise<WorkflowResultFile | null> {
  const path = resolve(runDir, RESULT_FILE);
  for (const keeper of activeKeepers()) {
    const kept = keeper.get(path);
    const parsed = kept && parseResult(kept.content);
    if (parsed) return Promise.resolve(parsed);
  }
  return readResult(runDir);
}

export async function upsertStoryRecord(
  runDir: string,
  header: ResultHeader,
  record: WorkflowStoryRecord,
): Promise<void> {
  await withResultLock(runDir, async () => {
    const current = await readResultForUpdate(runDir);
    await writeResult(runDir, {
      schemaVersion: 1,
      runId: header.runId,
      feature: header.feature,
      stories: { ...(current?.stories ?? {}), [record.storyId]: record },
      ...(current?.featureWorkflow ? { featureWorkflow: current.featureWorkflow } : {}),
      ...(current?.verdict ? { verdict: current.verdict } : {}),
      ...(current?.preflightTokensByRole ? { preflightTokensByRole: current.preflightTokensByRole } : {}),
    });
  });
}

/**
 * US-004: this run's pre-flight spend, per role. Written once by `runWorkflowPreflight` — the file
 * may not exist yet, so this is also the run's first result write. Every later write keeps the field.
 */
export async function writePreflightTokens(
  runDir: string,
  header: ResultHeader,
  byRole: Readonly<Record<string, RoleTokens>>,
): Promise<void> {
  await withResultLock(runDir, async () => {
    const current = await readResultForUpdate(runDir);
    await writeResult(runDir, {
      schemaVersion: 1,
      runId: header.runId,
      feature: header.feature,
      stories: current?.stories ?? {},
      preflightTokensByRole: byRole,
      ...(current?.featureWorkflow ? { featureWorkflow: current.featureWorkflow } : {}),
      ...(current?.verdict ? { verdict: current.verdict } : {}),
    });
  });
}

async function writeResult(runDir: string, next: WorkflowResultFile): Promise<void> {
  await _resultDeps.mkdir(runDir, { recursive: true });
  const path = join(runDir, RESULT_FILE);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  await runStateWrite(path, { content: text }, () => writeStagedFile(path, text, _resultDeps));
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
  header: ResultHeader,
  record: WorkflowFeatureRecord,
): Promise<void> {
  await withResultLock(runDir, () => writeFeatureRecord(runDir, header, record));
}

async function writeFeatureRecord(runDir: string, header: ResultHeader, record: WorkflowFeatureRecord): Promise<void> {
  const current = await readResultForUpdate(runDir);
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
