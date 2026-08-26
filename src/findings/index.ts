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

export type { ReviewCheckResult } from "../review/types";
export {
  acceptanceDiagnoseRawArrayToFindings,
  acceptanceDiagnoseRawToFinding,
  acFailureToFinding,
  acSentinelToFinding,
  executionFailureToFinding,
  genericTypecheckDiagnosticToFinding,
  lintDiagnosticToFinding,
  pluginToFinding,
  reviewFindingToFinding,
  testFailureToFinding,
  testSummaryToFindings,
} from "./adapters";
export { isNaxBailWrapper, markNaxBailWrapper } from "./bail-marker";
export { _cycleDeps, classifyOutcome, runFixCycle } from "./cycle";
export type { RecordIterationContext, RecordIterationInput } from "./cycle-iteration-log";
export { recordIteration } from "./cycle-iteration-log";
export type { DeclineLedger } from "./cycle-retirement";
export { createDeclineLedger } from "./cycle-retirement";
export type {
  FixApplied,
  FixCycle,
  FixCycleConfig,
  FixCycleContext,
  FixCycleExitReason,
  FixCycleResult,
  FixStrategy,
  FixStrategyWithExtractApplied,
  Iteration,
  IterationOutcome,
  ValidateResult,
} from "./cycle-types";
export { rebaseToWorkdir } from "./path-utils";
export type { StoryFixHistory, StoryFixState } from "./story-fix-history";
export {
  appendStoryFixIterations,
  createStoryFixHistory,
  getStoryFixState,
  mergeStoryFixDeclines,
  storyFixKey,
} from "./story-fix-history";
export type {
  Finding,
  FindingSeverity,
  FindingSource,
  FixTarget,
} from "./types";
export { compareSeverity, findingKey, findingRecurrenceKey, SEVERITY_ORDER } from "./types";
