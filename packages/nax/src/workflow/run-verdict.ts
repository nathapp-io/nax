/**
 * Loading a feature's newest readable workflow run (SPEC-workflow-status US-003, reused by
 * SPEC-workflow-record-promote US-002).
 *
 * `nax workflow status`, `nax workflow record` and (US-004) `nax workflow promote` all read the same
 * three things out of the same directory: the run's `result.json`, the feature record inside it, and
 * the open items that record still leaves. Building them in one place is what keeps `record`'s
 * validation and `status`'s report from disagreeing about what is open.
 *
 * A leaf module: it imports `open-items`, `paths` and `result` by relative path rather than through
 * the `@/workflow` barrel, which loads `step-context` and therefore `@/cli`. `src/cli/workflow.ts`
 * imports this module by relative path for the same reason (see its header).
 */
import { basename } from "node:path";
import { NaxError } from "@/errors";
import { validateFeatureName } from "@/utils/feature-name";
import { buildOpenItems, buildVerdict } from "./open-items";
import { workflowFeatureDir } from "./paths";
import { readResult, runDirsNewestFirst, storyStatesFrom } from "./result";
import type { OpenItem, WorkflowFeatureRecord, WorkflowResultFile } from "./types";

/** The newest readable run of a feature, with everything the workflow commands read off it. */
export interface LoadedRun {
  readonly runId: string;
  readonly runDir: string;
  readonly result: WorkflowResultFile;
  /** The feature record as the run stored it, with no `storyStates` filled in. */
  readonly record: WorkflowFeatureRecord;
  /** What `status` reports as open: built from the record with `storyStates` filled. */
  readonly openItems: readonly OpenItem[];
  /** The record's own reasons, as written. */
  readonly reasons: readonly string[];
}

/**
 * The newest run directory whose `result.json` parses. `runDirsNewestFirst` already drops the
 * directories holding no `result.json`; an unreadable or non-JSON one is skipped for the next.
 */
async function newestResult(
  dir: string,
  feature: string,
): Promise<{ runId: string; runDir: string; result: WorkflowResultFile } | null> {
  for (const runDir of await runDirsNewestFirst(workflowFeatureDir(dir, feature))) {
    const result = await readResult(runDir);
    if (result) return { runId: basename(runDir), runDir, result };
  }
  return null;
}

/**
 * US-002/US-003: the record carries its own `storyStates` when `publish` wrote them; a record from
 * an older nax (or a run that never reached publish) leaves the stories to `result.stories`, read
 * here with the same rule `upsertFeatureRecord` applies — so both report the same items.
 *
 * Exported for `nax workflow status`, which needs the verdict built from the filled record for the
 * two report fields the verdict owns (`outcome`, `workflowPassed`).
 */
export function fillStoryStates(record: WorkflowFeatureRecord, result: WorkflowResultFile): WorkflowFeatureRecord {
  return record.storyStates ? record : { ...record, storyStates: storyStatesFrom(result.stories) };
}

function notStarted(feature: string, runId: string): NaxError {
  return new NaxError(
    `workflow for ${feature} has not started its feature steps (run ${runId})`,
    "WORKFLOW_NOT_STARTED",
    { stage: "workflow", feature, runId },
  );
}

function noResult(feature: string): NaxError {
  return new NaxError(`no workflow result for feature ${feature}`, "WORKFLOW_RESULT_MISSING", {
    stage: "workflow",
    feature,
  });
}

/**
 * The newest readable run of `feature` under `dir`, or the error that says why there is none.
 * Validates the feature name first, so nothing is read for a name that could escape the tree.
 */
export async function loadRunVerdict(dir: string, feature: string): Promise<LoadedRun> {
  validateFeatureName(feature);
  const found = await newestResult(dir, feature);
  if (!found) throw noResult(feature);
  const record = found.result.featureWorkflow;
  if (!record) throw notStarted(feature, found.runId);
  const filled = fillStoryStates(record, found.result);
  const verdict = buildVerdict(filled);
  return {
    runId: found.runId,
    runDir: found.runDir,
    result: found.result,
    record,
    // A run that never published has no verdict, but its stories still say what is open (AC-13).
    openItems: verdict?.openItems ?? buildOpenItems(filled),
    reasons: record.reasons,
  };
}
