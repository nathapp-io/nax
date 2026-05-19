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
 * Validation scope:
 * 1. story.id — required non-blank identifier for log correlation.
 * 2. story.title — required non-blank for context injection into slot prompts.
 * 3. config.agent.default — required non-blank; schema allows "" override and an empty
 *    value causes silent agent-lookup failure in every orchestrator slot.
 * 4. config.models[agent.default] — at least one tier mapping must exist for the chosen
 *    agent; absent entries cause silent undefined returns during model-tier resolution
 *    in every callOp invocation (hidden null propagation, AC4).
 *
 * Test pattern validation is deferred to the downstream orchestrator (see AC3 rationale in
 * the test file).
 *
 * @param story - The story to validate
 * @param config - The config to validate; must have been parsed through NaxConfigSchema
 * @returns Valid PlanInputs or throws NaxError with stage='execution-inputs'
 * @throws NaxError with code 'STORY_ID_INVALID' if story.id is missing or blank
 * @throws NaxError with code 'STORY_TITLE_MISSING' if story.title is missing or blank
 * @throws NaxError with code 'CONFIG_INVALID' if config.agent.default is empty
 * @throws NaxError with code 'CONFIG_INVALID' if config.models has no tier mapping for the
 *   default agent (field: "models")
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

  const agentName = config.agent.default;
  if (!config.models?.[agentName] || Object.keys(config.models[agentName]).length === 0) {
    throw new NaxError(
      `Configuration error: no model tier mappings defined for agent "${agentName}" — slot input derivation requires at least one tier mapping`,
      "CONFIG_INVALID",
      {
        stage: "execution-inputs",
        storyId: story.id,
        field: "models",
      },
    );
  }

  return {
    story,
    config,
  };
}
