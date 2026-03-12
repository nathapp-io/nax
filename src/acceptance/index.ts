/**
 * Acceptance Test Generation Module
 *
 * Barrel exports for acceptance test generation functionality.
 */

export type {
  AcceptanceCriterion,
  GenerateAcceptanceTestsOptions,
  AcceptanceTestResult,
  RefinedCriterion,
  RefinementContext,
} from "./types";

export {
  buildRefinementPrompt,
  parseRefinementResponse,
  refineAcceptanceCriteria,
  _refineDeps,
} from "./refinement";

export {
  parseAcceptanceCriteria,
  buildAcceptanceTestPrompt,
  generateAcceptanceTests,
  generateSkeletonTests,
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
