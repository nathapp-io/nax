/**
 * The workflow-aware end-of-run summary (nax#2491 P5). Built from result.json, which already
 * holds per-role tokens and the story rounds; nothing is recomputed from the usage ledger.
 */
import type { WorkflowSummaryView } from "@/log-format";
import { workflowRunDir } from "./paths";
import { readResult } from "./result";
import { addRoleTokens } from "./tokens";
import type { RoleTokens, WorkflowFeatureRecord, WorkflowResultFile } from "./types";

export interface WorkflowTiming {
  readonly storiesDurationMs: number;
  readonly featureWorkflowDurationMs: number;
}

/** US-005: how the end-of-run surfaces point a human at the flagged decisions. */
const FLAGGED_LIST_COMMAND = "nax advisor list";

function rolesOf(result: WorkflowResultFile): WorkflowSummaryView["roles"] {
  const total: Readonly<Record<string, RoleTokens>> = [
    ...Object.values(result.stories).map((s) => s.tokensByRole ?? {}),
    result.featureWorkflow?.tokensByRole ?? {},
    // US-004: the pre-flight runs before the first story and belongs to no story record, so without
    // this its spend is missing from the role table (and from the run's role total) entirely.
    result.preflightTokensByRole ?? {},
  ].reduce((acc, next) => addRoleTokens(acc, next), {});
  return Object.entries(total)
    .map(([role, t]) => ({ role, ...t }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

/** Story minors nobody fixed, plus the ones the branch review itself raised. */
function minorsLeftOf(rec: WorkflowFeatureRecord): number {
  return rec.minors.filter((m) => m.triage === "leave").length + rec.newMinors.length;
}

/** Found = every blocking branch finding issued a B id; the repo-gate findings share the counter and are not counted. */
function branchOf(rec: WorkflowFeatureRecord): NonNullable<WorkflowSummaryView["branch"]> {
  const found = Math.max(0, rec.nextFindingId - 1 - rec.gateFindings.length);
  const left = rec.reviewOpen.length;
  return {
    found,
    fixed: Math.max(0, found - left),
    left,
    minorsLeft: minorsLeftOf(rec),
    ...(rec.fixRounds ? { fixRounds: rec.fixRounds } : {}),
  };
}

/** The command that lists the feature's decisions; without a feature name, the whole ledger. */
function flaggedHint(feature?: string): string {
  return feature ? `${FLAGGED_LIST_COMMAND} -f ${feature}` : FLAGGED_LIST_COMMAND;
}

/**
 * US-005: the ids the record flagged for a human. Only a non-empty list is surfaced — an empty one
 * says nothing the missing section does not, and records written before the field have none at all.
 */
function flaggedOf(
  rec: WorkflowFeatureRecord | undefined,
  feature?: string,
): NonNullable<WorkflowSummaryView["flagged"]> | undefined {
  const ids = rec?.flaggedDecisions;
  if (!ids || ids.length === 0) return undefined;
  return { ids: [...ids], hint: flaggedHint(feature) };
}

export function buildWorkflowRunSummary(
  result: WorkflowResultFile | null,
  timing: WorkflowTiming,
  feature?: string,
): WorkflowSummaryView | null {
  if (!result) return null;
  const rec = result.featureWorkflow;
  const finalGates = rec?.finalGates ?? rec?.repoGates;
  const flagged = flaggedOf(rec, feature);
  return {
    ...timing,
    roles: rolesOf(result),
    stories: Object.values(result.stories).map((s) => ({
      id: s.storyId,
      rounds: s.round,
      maxRounds: s.maxRounds,
      ...(s.state ? { state: s.state } : {}),
    })),
    ...(rec?.reviewRan ? { branch: branchOf(rec) } : {}),
    ...(rec && !rec.reviewRan ? { branchReviewSkipped: { minorsLeft: minorsLeftOf(rec) } } : {}),
    ...(finalGates ? { finalGates: finalGates.failing.length === 0 ? ("green" as const) : ("red" as const) } : {}),
    ...(rec?.gateRepairRounds ? { gateRepairRounds: rec.gateRepairRounds } : {}),
    ...(rec?.outcome
      ? { publish: { outcome: rec.outcome, ...(rec.url ? { url: rec.url } : {}), reasons: rec.reasons } }
      : {}),
    ...(flagged ? { flagged } : {}),
  };
}

/** Reads this run's result.json and builds the summary; null when the run left none. */
export async function readWorkflowRunSummary(
  projectDir: string,
  feature: string,
  runId: string,
  timing: WorkflowTiming,
): Promise<WorkflowSummaryView | null> {
  return buildWorkflowRunSummary(await readResult(workflowRunDir(projectDir, feature, runId)), timing, feature);
}
