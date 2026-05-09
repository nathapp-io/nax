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

export { parseRefinementResponse } from "./refinement";

export {
  parseAcceptanceCriteria,
  buildAcceptanceTestPrompt,
  generateSkeletonTests,
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
  findExistingAcceptanceTestPath,
  groupStoriesByPackage,
  resolveAcceptanceFeatureTestPath,
} from "./test-path";
