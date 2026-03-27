/**
 * Decompose module types.
 *
 * DecomposeAgentConfig, SubStory, DecomposeResult, ValidationResult.
 */

/** Configuration for the decompose agent (runtime input). Use DecomposeConfig from config/runtime-types for the full NaxConfig schema. */
export interface DecomposeAgentConfig {
  /** Maximum number of sub-stories to generate */
  maxSubStories: number;
  /** Maximum allowed complexity for any sub-story */
  maxComplexity: "simple" | "medium" | "complex" | "expert";
  /** Maximum number of retries on validation failure */
  maxRetries?: number;
}

/** A single decomposed sub-story */
export interface SubStory {
  /** Sub-story ID (e.g., "SD-001-1") */
  id: string;
  /** Parent story ID */
  parentStoryId: string;
  /** Sub-story title */
  title: string;
  /** Sub-story description */
  description: string;
  /** Acceptance criteria */
  acceptanceCriteria: string[];
  /** Tags for routing */
  tags: string[];
  /** Dependencies (story IDs) */
  dependencies: string[];
  /** Complexity classification */
  complexity: "simple" | "medium" | "complex" | "expert";
  /** Justification that this sub-story does not overlap with sibling stories */
  nonOverlapJustification: string;
}

/** Validation result for decomposition output */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Result of decomposing a story */
export interface DecomposeResult {
  subStories: SubStory[];
  validation: ValidationResult;
}

/** Adapter interface for calling the decompose LLM */
export interface DecomposeAdapter {
  decompose(prompt: string): Promise<string>;
}
