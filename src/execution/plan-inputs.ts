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
import type { ResolvedTestPatterns } from "../test-runners";

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
  /** Resolved test file patterns — present when the caller explicitly provided them. */
  readonly resolvedTestPatterns?: ResolvedTestPatterns;
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
 * 5. resolvedTestPatterns — when the caller explicitly passes `null` (meaning patterns were
 *    required but could not be resolved), throws deterministically rather than propagating
 *    null through test-slot input derivation (AC3).
 *    Pass `undefined` or omit the argument when test patterns are not needed for the plan.
 *
 * @param story - The story to validate
 * @param config - The config to validate; must have been parsed through NaxConfigSchema
 * @param resolvedTestPatterns - Resolved test file patterns; pass `null` when patterns were
 *   required but could not be resolved (triggers deterministic failure per AC3). Omit or
 *   pass `undefined` when test patterns are not needed for this plan.
 * @returns Valid PlanInputs or throws NaxError with stage='execution-inputs'
 * @throws NaxError with code 'STORY_ID_INVALID' if story.id is missing or blank
 * @throws NaxError with code 'STORY_TITLE_MISSING' if story.title is missing or blank
 * @throws NaxError with code 'CONFIG_INVALID' if config.agent.default is empty
 * @throws NaxError with code 'CONFIG_INVALID' if config.models has no tier mapping for the
 *   default agent (field: "models")
 * @throws NaxError with code 'TEST_PATTERNS_MISSING' if resolvedTestPatterns is explicitly null
 */
export function assemblePlanInputs(
  story: UserStory,
  config: NaxConfig,
  resolvedTestPatterns?: ResolvedTestPatterns | null,
): PlanInputs {
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

  // AC3: explicit null signals that patterns were required but could not be resolved.
  // Failing here with a structured error prevents null propagation into test-slot inputs.
  if (resolvedTestPatterns === null) {
    throw new NaxError(
      "Resolved test patterns are required but missing — test slot inputs cannot be derived without them",
      "TEST_PATTERNS_MISSING",
      {
        stage: "execution-inputs",
        storyId: story.id,
        field: "resolvedTestPatterns",
      },
    );
  }

  return {
    story,
    config,
    ...(resolvedTestPatterns !== undefined ? { resolvedTestPatterns } : {}),
  };
}
