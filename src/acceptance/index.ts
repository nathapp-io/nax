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
export { loadSourceFilesForDiagnosis } from "./fix-diagnosis";

export {
  acceptanceTestFilename,
  buildAcceptanceRunCommand,
  buildAcceptanceTestPrompt,
  generateSkeletonTests,
  parseAcceptanceCriteria,
  substituteAcceptanceTestPath,
} from "./generator";
export type { HardeningContext, HardeningResult } from "./hardening";
export { runHardeningPass } from "./hardening";
export { isStubTestContent } from "./heuristics";
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
