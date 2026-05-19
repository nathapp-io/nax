/**
 * PlanInputs Assembly
 *
 * Introduces PlanInputs as a typed boundary for all orchestrator slots,
 * with explicit validation to prevent hidden null propagation during
 * plan construction.
 */

import type { NaxConfig } from "../config/schema";
import { NaxError } from "../errors";
import type {
  AdversarialReviewInput,
  FullSuiteGateInput,
  GreenfieldGateInput,
  ImplementerInput,
  SemanticReviewInput,
  TestWriterInput,
  VerifierInput,
} from "../operations";
import type { UserStory } from "../prd/types";

/**
 * PlanInputs contains the typed boundary for all orchestrator slots.
 * Assembled by assemblePlanInputs with explicit validation.
 *
 * AC1: Includes testWriter, greenfieldGate, implementer, fullSuiteGate,
 * verifier, semanticReview, adversarialReview, and optionally rectification.
 */
export interface PlanInputs {
  readonly story: UserStory;
  readonly config: NaxConfig;
  readonly testWriter?: TestWriterInput;
  readonly greenfieldGate?: GreenfieldGateInput;
  readonly implementer?: ImplementerInput;
  readonly fullSuiteGate?: FullSuiteGateInput;
  readonly verifier?: VerifierInput;
  readonly semanticReview?: SemanticReviewInput;
  readonly adversarialReview?: AdversarialReviewInput;
  readonly rectification?: unknown; // Placeholder for rectification options
}

/**
 * Assemble and validate PlanInputs from story and config.
 *
 * AC2: Validates required data before returning PlanInputs.
 * AC3: Missing resolved test patterns produces deterministic structured failure.
 * AC4: Invalid or missing config produces deterministic structured failure.
 * AC5: Failures use NaxError with machine-readable code and context.stage='execution-inputs'.
 *
 * Test pattern validation is deferred to the downstream orchestrator setup; this function
 * validates only the minimum boundary contract required to begin plan assembly.
 *
 * @param story - The story to validate
 * @param config - The config to validate
 * @returns Valid PlanInputs or throws NaxError with stage='execution-inputs'
 * @throws NaxError with code 'STORY_ID_INVALID' if story.id is missing or blank
 * @throws NaxError with code 'STORY_TITLE_MISSING' if story.title is missing or blank
 * @throws NaxError with code 'CONFIG_INVALID' if config.agent.default is not set
 */
export function assemblePlanInputs(story: UserStory, config: NaxConfig): PlanInputs {
  // Stub: will be implemented in next phase
  // For now, just validate and return the inputs for type checking
  if (!story.id || story.id.trim() === "") {
    throw new NaxError("Story ID is required and must be non-empty", "STORY_ID_INVALID", {
      stage: "execution-inputs",
      storyId: story.id,
    });
  }

  if (!story.title || story.title.trim() === "") {
    throw new NaxError("Story title is required and must be non-empty", "STORY_TITLE_MISSING", {
      stage: "execution-inputs",
      storyId: story.id,
    });
  }

  if (!config.agent?.default) {
    throw new NaxError("Configuration error: agent.default is required", "CONFIG_INVALID", {
      stage: "execution-inputs",
      storyId: story.id,
      field: "agent.default",
    });
  }

  return {
    story,
    config,
  };
}
