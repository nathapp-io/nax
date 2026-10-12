/** Feature-workflow state (P4-R1, P4-R2): the record, story states across runs, prior-run resume. */
import { basename } from "node:path";
import { getSafeLogger } from "@/logger";
import type { PRD } from "@/prd";
import type { LedgerItem } from "./ledger-items";
import { isReusablePreflight, type PreflightFile, preflightPath } from "./preflight";
import { readResult, runDirsNewestFirst } from "./result";
import type { FeatureStep, MinorItem, StorySummary, WorkflowFeatureRecord, WorkflowStoryRecord } from "./types";

export const FEATURE_STEPS: readonly FeatureStep[] = [
  "repo-gates",
  "branch-review",
  "branch-fix",
  "branch-rereview",
  "adjudicate",
  "final-gates",
  "publish",
  "done",
];

const PASSED_EARLIER = "passed earlier, no workflow record";

export function newFeatureRecord(input: {
  readonly now: string;
  readonly seed: string | null;
  readonly minors: readonly MinorItem[];
}): WorkflowFeatureRecord {
  return {
    step: "repo-gates",
    startedAt: input.now,
    seed: input.seed,
    gateFindings: [],
    reviewRan: false,
    reviewOpen: [],
    minors: input.minors,
    newMinors: [],
    nextFindingId: 1,
    fixRan: false,
    rulings: [],
    reasons: [],
    timings: {},
    tokensByRole: {},
  };
}

export function minorsFrom(deferred: readonly LedgerItem[]): MinorItem[] {
  return deferred.map((m, i) => ({ id: `M${i + 1}`, storyId: m.storyId, text: m.text, triage: "leave" }));
}

export interface LocatedStoryRecord {
  readonly record: WorkflowStoryRecord;
  readonly runDir: string;
}

/** Every story's newest record across the feature's runs (P4-R2). */
export async function collectStoryRecords(featureDir: string): Promise<Readonly<Record<string, LocatedStoryRecord>>> {
  const found = new Map<string, LocatedStoryRecord>();
  for (const runDir of await runDirsNewestFirst(featureDir)) {
    const stories = (await readResult(runDir))?.stories ?? {};
    for (const [id, record] of Object.entries(stories)) {
      if (!found.has(id)) found.set(id, { record, runDir });
    }
  }
  return Object.fromEntries(found);
}

function isFeatureRecord(v: unknown): v is WorkflowFeatureRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    FEATURE_STEPS.includes(o.step as FeatureStep) &&
    Array.isArray(o.gateFindings) &&
    Array.isArray(o.reviewOpen) &&
    Array.isArray(o.minors) &&
    Array.isArray(o.rulings) &&
    Array.isArray(o.reasons)
  );
}

/** The newest OTHER run's feature record (P4-R1); a malformed record is skipped with a warning. */
export async function loadPriorFeature(
  featureDir: string,
  currentRunId: string,
): Promise<WorkflowFeatureRecord | null> {
  for (const runDir of await runDirsNewestFirst(featureDir)) {
    if (basename(runDir) === currentRunId) continue;
    const feature = (await readResult(runDir))?.featureWorkflow;
    if (feature === undefined) continue;
    if (isFeatureRecord(feature)) return feature;
    getSafeLogger()?.warn("workflow", "Prior feature record is malformed — ignored", { storyId: "_run", runDir });
  }
  return null;
}

function fromRecord(id: string, title: string, located: LocatedStoryRecord): StorySummary | null {
  const r = located.record;
  if (!r.state) return null;
  return {
    id,
    title,
    state: r.state,
    ...(r.reason ? { reason: r.reason } : {}),
    rounds: r.round,
    unreviewed: r.unreviewed,
    flagged: r.flagged ?? 0,
    runDir: located.runDir,
  };
}

export function summariseStories(prd: PRD, records: Readonly<Record<string, LocatedStoryRecord>>): StorySummary[] {
  return prd.userStories.map((s) => {
    const located = records[s.id];
    const closed = located ? fromRecord(s.id, s.title, located) : null;
    if (closed) return closed;
    const base = { id: s.id, title: s.title, unreviewed: false, flagged: 0 };
    if (s.passes || s.status === "passed") return { ...base, state: "complete", reason: PASSED_EARLIER, rounds: 0 };
    return { ...base, state: "not-run", rounds: located?.record.round ?? 0 };
  });
}

/** The newest reusable preflight.json of the feature (P4-R14); failed or malformed files are skipped. */
export async function newestPreflight(
  featureDir: string,
): Promise<{ readonly path: string; readonly file: PreflightFile } | null> {
  for (const runDir of await runDirsNewestFirst(featureDir)) {
    const path = preflightPath(runDir);
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (isReusablePreflight(parsed)) return { path, file: parsed };
    } catch {
      // unreadable: try an older run
    }
  }
  return null;
}
