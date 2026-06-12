/**
 * Acceptance Test Generation Module
 *
 * Barrel exports for acceptance test generation functionality.
 */

export type {
  AcceptanceCriterion,
  DiagnosisResult,
  RefinedCriterion,
  RefinementContext,
} from "./types";

export { parseRefinementResponse, refinementWouldFallback } from "./refinement";

export {
  acceptanceTestFilename,
  buildAcceptanceRunCommand,
  buildAcceptanceTestPrompt,
  generateSkeletonTests,
  parseAcceptanceCriteria,
} from "./generator";

export type { FixStory } from "./fix-generator";

export {
  findRelatedStories,
  parseACTextFromSpec,
  convertFixStoryToUserStory,
} from "./fix-generator";

export type { AcceptanceEntry } from "./content-loader";
export { loadAcceptanceTestContent } from "./content-loader";
export { loadSemanticVerdicts } from "./semantic-verdict";
export {
  _groupDeps,
  findExistingAcceptanceTestPath,
  groupStoriesByPackage,
  resolveAcceptanceFeatureTestPath,
  resolveSuggestedPackageFeatureTestPath,
  resolveSuggestedTestFile,
  suggestedTestFilename,
} from "./test-path";
export { runHardeningPass } from "./hardening";
export type { HardeningContext, HardeningResult } from "./hardening";
