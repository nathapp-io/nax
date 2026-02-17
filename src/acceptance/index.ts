/**
 * Acceptance Test Generation Module
 *
 * Barrel exports for acceptance test generation functionality.
 */

export type {
  AcceptanceCriterion,
  GenerateAcceptanceTestsOptions,
  AcceptanceTestResult,
} from "./types";

export {
  parseAcceptanceCriteria,
  buildAcceptanceTestPrompt,
  generateAcceptanceTests,
  generateSkeletonTests,
} from "./generator";
