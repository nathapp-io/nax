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

function rolesOf(result: WorkflowResultFile): WorkflowSummaryView["roles"] {
  const total: Readonly<Record<string, RoleTokens>> = [
    ...Object.values(result.stories).map((s) => s.tokensByRole ?? {}),
    result.featureWorkflow?.tokensByRole ?? {},
  ].reduce((acc, next) => addRoleTokens(acc, next), {});
  return Object.entries(total)
    .map(([role, t]) => ({ role, ...t }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

/** Found = every blocking branch finding issued a B id; the repo-gate findings share the counter and are not counted. */
function branchOf(rec: WorkflowFeatureRecord): NonNullable<WorkflowSummaryView["branch"]> {
  const found = Math.max(0, rec.nextFindingId - 1 - rec.gateFindings.length);
  const left = rec.reviewOpen.length;
  return {
    found,
    fixed: Math.max(0, found - left),
    left,
    minorsLeft: rec.minors.filter((m) => m.triage === "leave").length + rec.newMinors.length,
  };
}

export function buildWorkflowRunSummary(
  result: WorkflowResultFile | null,
  timing: WorkflowTiming,
): WorkflowSummaryView | null {
  if (!result) return null;
  const rec = result.featureWorkflow;
  const finalGates = rec?.finalGates ?? rec?.repoGates;
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
    ...(rec && !rec.reviewRan ? { branchReviewSkipped: true } : {}),
    ...(finalGates ? { finalGates: finalGates.failing.length === 0 ? ("green" as const) : ("red" as const) } : {}),
    ...(rec?.outcome
      ? { publish: { outcome: rec.outcome, ...(rec.url ? { url: rec.url } : {}), reasons: rec.reasons } }
      : {}),
  };
}

/** Reads this run's result.json and builds the summary; null when the run left none. */
export async function readWorkflowRunSummary(
  projectDir: string,
  feature: string,
  runId: string,
  timing: WorkflowTiming,
): Promise<WorkflowSummaryView | null> {
  return buildWorkflowRunSummary(await readResult(workflowRunDir(projectDir, feature, runId)), timing);
}
