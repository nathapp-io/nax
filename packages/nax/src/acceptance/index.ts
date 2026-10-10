/**
 * Acceptance Test Generation Module
 *
 * Barrel exports for acceptance test generation functionality.
 */

export type { AcceptanceEntry } from "./content-loader";
export { loadAcceptanceTestContent } from "./content-loader";
export type { AcceptanceCoverageEntry } from "./coverage";
export {
  checkAcceptanceCoverage,
  findMissingAcceptanceTestPaths,
  makeAcceptanceCoverageCollector,
  warnMissingAcceptanceTests,
} from "./coverage";
export type { AcceptanceExecution } from "./execution-description";
export { _acceptanceExecutionDeps, resolveAcceptanceExecution } from "./execution-description";
export type { FailedCriterion, RefinedCriterionRecord } from "./failed-criteria";
export {
  _failedCriteriaDeps,
  groupStoryIdsForPackage,
  loadRefinedCriteria,
  resolveFailedCriteria,
} from "./failed-criteria";
export { loadSourceFilesForDiagnosis } from "./fix-diagnosis";
export {
  acceptanceTestFilename,
  buildAcceptanceRunCommand,
  buildAcceptanceTestPrompt,
  effectiveAcceptanceFramework,
  generateSkeletonTests,
  parseAcceptanceCriteria,
  substituteAcceptanceTestPath,
} from "./generator";
export type { HardeningContext, HardeningResult } from "./hardening";
export { runHardeningPass } from "./hardening";
export { isStubTestContent } from "./heuristics";
export type { OverrideLookup, OverrideLookupOptions } from "./override-keys";
export { createOverrideLookup, OVERRIDE_SCOPE_SEPARATOR, scopedOverrideKey } from "./override-keys";
export { parseRefinementResponse, refinementWouldFallback } from "./refinement";
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
