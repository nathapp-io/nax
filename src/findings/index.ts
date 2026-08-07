/**
 * src/findings — unified Finding wire format (ADR-021) and cycle orchestration
 * types + runtime (ADR-022).
 *
 * ADR-021: Finding wire format — types, severity ordering, stable identity key,
 * and per-producer adapter converters.
 *
 * ADR-022 Phase 1: cycle orchestration types — Iteration, FixApplied,
 * FixStrategy, FixCycle, FixCycleResult, FixCycleContext, FixCycleConfig.
 *
 * ADR-022 Phase 2: runFixCycle and classifyOutcome behaviour.
 */

export type {
  Finding,
  FindingSeverity,
  FindingSource,
  FixTarget,
} from "./types";

export { SEVERITY_ORDER, compareSeverity, findingKey } from "./types";

export {
  acceptanceDiagnoseRawArrayToFindings,
  acceptanceDiagnoseRawToFinding,
  acFailureToFinding,
  acSentinelToFinding,
  executionFailureToFinding,
  lintDiagnosticToFinding,
  pluginToFinding,
  reviewFindingToFinding,
  testFailureToFinding,
  testSummaryToFindings,
  genericTypecheckDiagnosticToFinding,
} from "./adapters";
export { rebaseToWorkdir } from "./path-utils";

export type {
  FixApplied,
  FixCycle,
  FixCycleConfig,
  FixCycleContext,
  FixCycleExitReason,
  FixCycleResult,
  FixStrategy,
  Iteration,
  IterationOutcome,
  ValidateResult,
} from "./cycle-types";

export type { ReviewCheckResult } from "../review/types";

export { classifyOutcome, runFixCycle, _cycleDeps } from "./cycle";
export { recordIteration } from "./cycle-iteration-log";
export type { RecordIterationContext, RecordIterationInput } from "./cycle-iteration-log";
export { createDeclineLedger } from "./cycle-retirement";
export type { DeclineLedger } from "./cycle-retirement";

export { isNaxBailWrapper, markNaxBailWrapper } from "./bail-marker";

export type { StoryFixHistory, StoryFixState } from "./story-fix-history";
export {
  appendStoryFixIterations,
  createStoryFixHistory,
  getStoryFixState,
  mergeStoryFixDeclines,
  storyFixKey,
} from "./story-fix-history";
