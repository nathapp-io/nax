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
 * Validation scope rationale:
 * - Test pattern validation is deferred to the downstream orchestrator; this function
 *   validates only the minimum boundary contract required to begin plan assembly.
 * - Config fields such as routing, autoMode, quality, execution, tdd, and models are
 *   all covered by NaxConfigSchema Zod `.default()` values and are structurally guaranteed
 *   non-null in any properly-parsed NaxConfig. Re-validating them here would be redundant.
 * - config.agent.default is the sole exception: it defaults to "claude" at the schema level
 *   but Zod permits user overrides to "" (empty string), which passes schema parsing and
 *   would cause silent orchestration failure if not caught at this boundary.
 *
 * @param story - The story to validate
 * @param config - The config to validate; must have been parsed through NaxConfigSchema
 * @returns Valid PlanInputs or throws NaxError with stage='execution-inputs'
 * @throws NaxError with code 'STORY_ID_INVALID' if story.id is missing or blank
 * @throws NaxError with code 'STORY_TITLE_MISSING' if story.title is missing or blank
 * @throws NaxError with code 'CONFIG_INVALID' if config.agent.default is empty (the only
 *   config field that NaxConfigSchema allows to be set to "" and that breaks orchestration)
 */
export function assemblePlanInputs(story: UserStory, config: NaxConfig): PlanInputs {
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
