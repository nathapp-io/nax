/** Wires the feature machine to the real steps, the result.json sink and the status block (spec §7). */
import { adjudicateResidual } from "./adjudicate";
import { createLiveWorkflowAdvisor, FEATURE_SCOPE } from "./advisor-live";
import { flaggedCount } from "./approval";
import { runBranchFix } from "./branch-fix";
import { runBranchReReview, runBranchReview, writeFeatureArtifact } from "./branch-review";
import type { FeatureContext, WorkflowFeatureInput } from "./feature-context";
import type { FeatureEnv, FeatureSink, FeatureSteps } from "./feature-machine";
import { publish } from "./finalize";
import { changedFilesSince, readHead } from "./git";
import { appendLedger, type LedgerWriteOptions } from "./ledger";
import type { LedgerItems } from "./ledger-items";
import type { PreflightFile } from "./preflight";
import { runRepoGates } from "./repo-gates";
import { upsertFeatureRecord } from "./result";
import { workflowStatusBlock } from "./status-block";
import { _workflowDeps } from "./step-context";
import { featureModelFor } from "./step-model";
import { addRoleTokens, type TokenMeter } from "./tokens";
import { withToolErrorOutcome } from "./tool-error-outcome";
import type { StorySummary, WorkflowFeatureRecord } from "./types";

export interface FeatureEnvInput {
  readonly stories: readonly StorySummary[];
  readonly ledgerItems: LedgerItems;
  readonly record: WorkflowFeatureRecord;
  readonly meter: TokenMeter;
  readonly preflight: { readonly path: string; readonly file: PreflightFile } | null;
  /** Repo-relative spec path, "" when the feature has none. */
  readonly specPath: string;
}

export function buildFeatureEnv(fc: FeatureContext, input: WorkflowFeatureInput, ctx: FeatureEnvInput): FeatureEnv {
  const spec = ctx.specPath ? { specPath: ctx.specPath } : {};
  const advisor = _workflowDeps.createAdvisor({
    callCtx: fc.callCtx,
    repoRoot: fc.projectDir,
    outputDir: fc.outputDir,
    feature: fc.feature,
    runId: fc.runId,
    specPath: ctx.specPath,
    workdir: fc.projectDir,
  });
  const live = createLiveWorkflowAdvisor({ advisor, feature: fc.feature, dependents: [] });
  const ledger = (text: string, options?: LedgerWriteOptions) => appendLedger(fc.runDir, FEATURE_SCOPE, text, options);
  const preflightFile = ctx.preflight?.file ?? null;
  // nax#2491 P8: after an agent step, say what became of any session's repeated tool errors.
  const toolErrors = <T>(label: string, run: () => Promise<T>): Promise<T> =>
    withToolErrorOutcome(
      {
        outputDir: fc.outputDir,
        feature: fc.feature,
        runId: fc.runId,
        storyId: FEATURE_SCOPE,
        now: () => _workflowDeps.now(),
      },
      label,
      run,
    );
  const steps: FeatureSteps = {
    repoGates: () => runRepoGates(fc),
    branchReview: (seed, facts) =>
      toolErrors("branch-review", () =>
        runBranchReview(fc, { seed, ...spec, ...(ctx.preflight ? { preflightPath: ctx.preflight.path } : {}), facts }),
      ),
    branchFix: (findings) => toolErrors("branch-fix", () => runBranchFix(fc, { ...spec, findings })),
    branchReReview: (findings, fixBase) =>
      toolErrors("branch-rereview", () => runBranchReReview(fc, { ...spec, findings, fixBase })),
    adjudicate: (items) => adjudicateResidual(live, { storyId: FEATURE_SCOPE, items, redGates: [] }, ledger),
    publish: (record) =>
      publish(fc, {
        record,
        stories: ctx.stories,
        flagged: flaggedCount(ctx.stories, preflightFile, record.rulings),
        advisor,
        preflight: preflightFile,
      }),
    head: () => readHead(fc.projectDir),
    changedFiles: (base) => changedFilesSince(fc.projectDir, base),
    modelFor: featureModelFor(fc),
  };
  const header = { runId: fc.runId, feature: fc.feature };
  const sink: FeatureSink = {
    update: (record) =>
      upsertFeatureRecord(fc.runDir, header, {
        ...record,
        tokensByRole: addRoleTokens(ctx.record.tokensByRole, ctx.meter.byRole()),
      }),
    ledger,
    artifact: (name, value) => writeFeatureArtifact(fc, name, value),
    step: (step, record) => input.statusWriter?.setWorkflowStatus?.(workflowStatusBlock(ctx.stories, step, record)),
  };
  return {
    steps,
    sink,
    facts: { stories: ctx.stories, parked: ctx.ledgerItems.parked, cannotVerify: ctx.ledgerItems.cannotVerify },
    record: ctx.record,
    aborted: () => fc.runSignal?.aborted === true,
    now: () => _workflowDeps.now(),
  };
}
