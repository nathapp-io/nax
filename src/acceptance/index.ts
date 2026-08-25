/**
 * Acceptance Test Generation Module
 *
 * Barrel exports for acceptance test generation functionality.
 */

export type { AcceptanceEntry } from "./content-loader";
export { loadAcceptanceTestContent } from "./content-loader";
export { loadSourceFilesForDiagnosis } from "./fix-diagnosis";

export type { FixStory } from "./fix-generator";

export {
  convertFixStoryToUserStory,
  findRelatedStories,
  parseACTextFromSpec,
} from "./fix-generator";
export {
  acceptanceTestFilename,
  buildAcceptanceRunCommand,
  buildAcceptanceTestPrompt,
  generateSkeletonTests,
  parseAcceptanceCriteria,
} from "./generator";
export type { HardeningContext, HardeningResult } from "./hardening";
export { runHardeningPass } from "./hardening";
export { isStubTestContent } from "./heuristics";
export { parseRefinementResponse, refinementWouldFallback } from "./refinement";
export { loadSemanticVerdicts, persistSemanticVerdict } from "./semantic-verdict";
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
