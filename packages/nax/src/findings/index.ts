/**
 * src/findings — unified Finding wire format (ADR-021) and the iteration records
 * that carry a fix attempt's history.
 *
 * ADR-021: Finding wire format — types and per-producer adapter converters.
 *
 * ADR-022 Phase 1: iteration record types — `Iteration`, `FixApplied`,
 * `IterationOutcome` — plus the run-scoped story fix history store.
 *
 * The cycle orchestration that consumed these types (`runFixCycle`, the strategy
 * contract, the decline ledger, the retirement stamps and the review recurrence
 * helpers) went with the findings fix cycle in C1 wave B2b-3. What remains is the
 * wire format, the iteration record and the store `createRuntime` still builds.
 */

export type { ReviewCheckResult } from "../review/types";
export {
  executionFailureToFinding,
  genericTypecheckDiagnosticToFinding,
  lintDiagnosticToFinding,
  testFailureToFinding,
  testSummaryToFindings,
} from "./adapters";
export type { FixApplied, Iteration, IterationOutcome } from "./cycle-types";
export { rebaseToWorkdir } from "./path-utils";
export type { StoryFixHistory, StoryFixState } from "./story-fix-history";
export { createStoryFixHistory } from "./story-fix-history";
export type {
  Finding,
  FindingSeverity,
  FindingSource,
  FixTarget,
} from "./types";
