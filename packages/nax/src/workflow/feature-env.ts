/** Wires the feature machine to the real steps, the result.json sink and the status block (spec §7). */
import { forgeReadProviderForUrl } from "@/forge-tools";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { adjudicateResidual } from "./adjudicate";
import { createLiveWorkflowAdvisor, FEATURE_SCOPE } from "./advisor-live";
import { flaggedCount } from "./approval";
import { runBranchFix } from "./branch-fix";
import { runBranchReReview, runBranchReview, writeFeatureArtifact } from "./branch-review";
import { readCiFailuresFor } from "./ci-failures";
import { costLimitReached } from "./cost-limit";
import type { FeatureContext, WorkflowFeatureInput } from "./feature-context";
import { _featureDeps } from "./feature-deps";
import type { FeatureEnv, FeatureSink, FeatureSteps } from "./feature-machine";
import { publish } from "./finalize";
import { changedFilesSince, readHead } from "./git";
import { postItemThreads } from "./item-threads-post";
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
    branchFix: (findings, opts) =>
      toolErrors("branch-fix", () =>
        runBranchFix(fc, {
          ...spec,
          findings,
          // US-002: a repair runs the same pass under the `wf-repair` identity, so the gate and CI
          // repairs are told apart from the branch fix in the meter, the commit and the log.
          ...(opts?.repair ? { kind: "repair" } : {}),
          // US-004: only the CI repair names a round, and it is what makes `runBranchFix` build the
          // CI repair's own brief instead of the branch-fix one.
          ...(opts?.ciRound !== undefined
            ? { ciRepair: { round: opts.ciRound, ...(opts.prUrl ? { prUrl: opts.prUrl } : {}) } }
            : {}),
          ...(opts?.prUrl
            ? { toolProviders: [forgeReadProviderForUrl(opts.prUrl, _featureDeps.forge, fc.projectDir)] }
            : {}),
        }),
      ),
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
    postItemThreads: (input) =>
      postItemThreads({ ...input, projectDir: fc.projectDir, feature: fc.feature }, _featureDeps.forge),
    head: () => readHead(fc.projectDir),
    changedFiles: (base) => changedFilesSince(fc.projectDir, base),
    // US-008: the real CI reader, so the publish step can read the failed checks of the PR it opened.
    readCiFailures: (input) => readCiFailuresFor(fc, input),
    // US-005: every trusted decision in the feature's ledger flagged for a human, across all its
    // runs and in ledger order. The throw is the machine's to handle: the step warns and goes on.
    flaggedDecisions: async () =>
      (await _workflowDeps.readTrustedDecisions(fc.projectDir, fc.feature, fc.outputDir))
        .filter((d) => d.needsHumanConfirm === true)
        .map((d) => d.id),
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
    step: (step, record) => {
      input.statusWriter?.setWorkflowStatus?.(workflowStatusBlock(ctx.stories, step, record));
      // US-003: the machine's terminal `sink.step("done", ...)` is its exit, not a step a hook should
      // start, so it carries no event. The machine calls this before `costStop`, so a step the run's
      // cost limit then skips has already sent its `workflow:step`.
      if (step !== "done") pipelineEventBus.emit({ type: "workflow:step", step });
    },
  };
  return {
    steps,
    itemThreadsIdentity: { projectDir: fc.projectDir, feature: fc.feature },
    sink,
    facts: { stories: ctx.stories, parked: ctx.ledgerItems.parked, cannotVerify: ctx.ledgerItems.cannotVerify },
    record: ctx.record,
    aborted: () => fc.runSignal?.aborted === true,
    // nax#2550: the story loop's cost check, so no agent step of the feature workflow runs past the limit.
    costExceeded: () => costLimitReached(fc.config.execution.costLimit, fc.callCtx.runtime),
    now: () => _workflowDeps.now(),
    limits: {
      maxBranchFixRounds: fc.workflow.maxBranchFixRounds,
      finalGateRepairRounds: fc.workflow.finalGateRepairRounds,
      ciRepairRounds: fc.workflow.ciRepairRounds,
    },
  };
}
