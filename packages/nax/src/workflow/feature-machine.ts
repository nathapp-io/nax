import { NaxError } from "@/errors";
import type { FailedCheck } from "@/forge";
import { runStepGraph, type StepGraphHooks, type StepGraphRunOptions } from "@/step-graph";
import type { BranchFixOutcome } from "./branch-fix";
import type { FeatureLimits } from "./branch-fix-rounds";
import type { BranchReviewFacts } from "./branch-review";
import { FEATURE_GRAPH } from "./feature-graph";
import { readHeadSoft } from "./feature-steps";
import type { PublishOutcome } from "./finalize";
import type { ItemThreadsInput, ItemThreadsOutcome } from "./item-threads-post";
import type { LedgerWriteOptions } from "./ledger";
import type { LedgerItem } from "./ledger-items";
import type { RepoGateRun } from "./repo-gates";
import type { StepModel } from "./run-log";
import type { ReviewOutcome } from "./story-review";
import type {
  BranchReviewVerdict,
  FeatureStep,
  ReReviewVerdict,
  StorySummary,
  WorkflowFeatureRecord,
  WorkflowFinding,
  WorkflowRuling,
} from "./types";

export interface FeatureSteps {
  repoGates(): Promise<RepoGateRun>;
  branchReview(seed: string, facts: BranchReviewFacts): Promise<ReviewOutcome<BranchReviewVerdict>>;
  branchFix(findings: readonly WorkflowFinding[], opts?: { readonly prUrl?: string }): Promise<BranchFixOutcome>;
  branchReReview(findings: readonly WorkflowFinding[], fixBase: string): Promise<ReviewOutcome<ReReviewVerdict>>;
  adjudicate(items: readonly WorkflowFinding[]): Promise<readonly WorkflowRuling[]>;
  publish(record: WorkflowFeatureRecord): Promise<PublishOutcome>;
  /** Optional durable PR items; absent preserves the original graph behavior. */
  postItemThreads?: (input: ItemThreadsInput) => Promise<ItemThreadsOutcome>;
  head(): Promise<string>;
  /** Repo-rooted paths changed between `base` and HEAD. Throws on a git failure. */
  changedFiles(base: string): Promise<readonly string[]>;
  /** The model a step will run on, for its start line (nax#2491 P6). Optional: absent names none. */
  modelFor?(step: "branch-review" | "branch-fix" | "branch-rereview"): StepModel | undefined;
  /**
   * US-005: the ids of the trusted ledger decisions flagged for a human, in ledger order.
   * Optional: absent means the run collects nothing and the record keeps no ids.
   */
  flaggedDecisions?(): Promise<readonly string[]>;
  /**
   * US-006: the failed checks of the published PR's CI, for the CI repair decision. Optional:
   * absent means the run cannot read CI logs, so it repairs no CI.
   */
  readCiFailures?(input: { url: string; head: string }): Promise<readonly FailedCheck[]>;
}

export interface FeatureSink {
  update(record: WorkflowFeatureRecord): Promise<void>;
  ledger(text: string, options?: LedgerWriteOptions): Promise<void>;
  step(step: FeatureStep, record: WorkflowFeatureRecord): void;
  /** Writes a review artifact into the run dir. Best effort: never throws. */
  artifact(name: string, value: unknown): Promise<void>;
}

export interface FeatureFacts {
  readonly stories: readonly StorySummary[];
  readonly parked: readonly LedgerItem[];
  readonly cannotVerify: readonly LedgerItem[];
}

export interface FeatureEnv {
  readonly steps: FeatureSteps;
  /** Captured from FeatureContext; optional for existing graph-only environments. */
  readonly itemThreadsIdentity?: Pick<ItemThreadsInput, "projectDir" | "feature">;
  readonly sink: FeatureSink;
  readonly facts: FeatureFacts;
  readonly record: WorkflowFeatureRecord;
  readonly aborted: () => boolean;
  /** nax#2550: the run's `execution.costLimit` check, read before every agent step; absent = no limit. */
  readonly costExceeded?: () => boolean;
  readonly now: () => number;
  /** The round caps; absent reads as the `workflow` schema defaults. */
  readonly limits?: FeatureLimits;
}

export type { FeatureLimits };

type RunFeatureGraph = (
  graph: typeof FEATURE_GRAPH,
  env: FeatureEnv,
  record: WorkflowFeatureRecord,
  hooks: StepGraphHooks<WorkflowFeatureRecord, FeatureStep>,
  options: StepGraphRunOptions<FeatureStep>,
) => Promise<WorkflowFeatureRecord>;

export const _featureMachineDeps: { runStepGraph: RunFeatureGraph } = { runStepGraph };

export function runFeatureMachine(env: FeatureEnv): Promise<WorkflowFeatureRecord> {
  return _featureMachineDeps.runStepGraph(
    FEATURE_GRAPH,
    env,
    env.record,
    { persist: (record) => env.sink.update(record), onStep: (step, record) => env.sink.step(step, record) },
    {
      aborted: () => env.aborted(),
      now: () => env.now(),
      costExceeded: () => env.costExceeded?.() === true,
      readHead: () => readHeadSoft(env),
      onAbort: (step) =>
        new NaxError("Run aborted during the feature workflow", "WORKFLOW_ABORTED", {
          stage: "workflow",
          storyId: "_run",
          step,
        }),
    },
  );
}
