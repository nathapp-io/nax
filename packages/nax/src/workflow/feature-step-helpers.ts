/**
 * The helpers the feature workflow's steps share (US-004).
 *
 * They live here rather than in `feature-steps.ts` because the CI repair has its own module
 * (`ci-repair-steps.ts`) and both need them: `ci-repair-steps.ts` must not import `feature-steps.ts`,
 * which imports it back — the import-cycle baseline is 0 (`bun run check:import-cycles`).
 */
import { WORKFLOW_DEFAULTS } from "@/config";
import { FEATURE_SCOPE } from "./advisor-live";
import type { FeatureLimits } from "./branch-fix-rounds";
import type { FeatureEnv } from "./feature-machine";
import type { LedgerWriteOptions } from "./ledger";
import { type StepLog, type StepModel, startStep } from "./run-log";

export const DEFAULT_LIMITS: FeatureLimits = {
  maxBranchFixRounds: WORKFLOW_DEFAULTS.maxBranchFixRounds,
  finalGateRepairRounds: WORKFLOW_DEFAULTS.finalGateRepairRounds,
  ciRepairRounds: WORKFLOW_DEFAULTS.ciRepairRounds,
};
export const limitsOf = (env: FeatureEnv): FeatureLimits => env.limits ?? DEFAULT_LIMITS;

export const costExceeded = (env: FeatureEnv): boolean => env.costExceeded?.() === true;

/** The step line in the log already says it; ledger.md still records it. */
export const NO_MIRROR: LedgerWriteOptions = { mirror: false };

/** Wall-clock timing for the log only; the record's `timings` keep using `env.now`. */
export const featureStep = (label: string, announce = true, bare = false, model?: StepModel): StepLog =>
  startStep(FEATURE_SCOPE, label, { announce, bare, model });

/** Round 1 is the plain label; every later round names its number (`branch fix r2`). */
export const roundLabel = (base: string, round: number): string => (round > 1 ? `${base} r${round}` : base);
