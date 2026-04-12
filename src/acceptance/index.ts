/**
 * Acceptance Test Generation Module
 *
 * Barrel exports for acceptance test generation functionality.
 */

export type {
  AcceptanceCriterion,
  GenerateAcceptanceTestsOptions,
  GenerateFromPRDOptions,
  AcceptanceTestResult,
  RefinedCriterion,
  RefinementContext,
} from "./types";

export {
  parseRefinementResponse,
  refineAcceptanceCriteria,
  _refineDeps,
} from "./refinement";

export {
  parseAcceptanceCriteria,
  buildAcceptanceTestPrompt,
  generateAcceptanceTests,
  generateFromPRD,
  generateSkeletonTests,
  _generatorPRDDeps,
} from "./generator";

export type {
  FixStory,
  GenerateFixStoriesOptions,
} from "./fix-generator";

export {
  generateFixStories,
  findRelatedStories,
  parseACTextFromSpec,
  convertFixStoryToUserStory,
} from "./fix-generator";

export type { AcceptanceEntry } from "./content-loader";
export { loadAcceptanceTestContent } from "./content-loader";
