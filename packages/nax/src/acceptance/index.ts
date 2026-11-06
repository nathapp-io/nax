/**
 * Acceptance Test Generation Module
 *
 * Barrel exports for acceptance test generation functionality.
 */

export type { AcceptanceExecution } from "./execution-description";
export { _acceptanceExecutionDeps, resolveAcceptanceExecution } from "./execution-description";
export type { FailedCriterion, RefinedCriterionRecord } from "./failed-criteria";
export {
  _failedCriteriaDeps,
  groupStoryIdsForPackage,
  loadRefinedCriteria,
  resolveFailedCriteria,
} from "./failed-criteria";
export {
  acceptanceTestFilename,
  buildAcceptanceRunCommand,
  buildAcceptanceTestPrompt,
  effectiveAcceptanceFramework,
  generateSkeletonTests,
  parseAcceptanceCriteria,
  substituteAcceptanceTestPath,
} from "./generator";
export { isStubTestContent } from "./heuristics";
export {
  _groupDeps,
  findExistingAcceptanceTestPath,
  groupStoriesByPackage,
  resolveAcceptanceFeatureTestPath,
  resolveSuggestedPackageFeatureTestPath,
  resolveSuggestedTestFile,
  suggestedTestFilename,
} from "./test-path";
export type {
  AcceptanceCriterion,
  DiagnosisResult,
  RefinedCriterion,
  RefinementContext,
} from "./types";
