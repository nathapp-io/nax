/**
 * LLM Routing Parsers & Validators
 *
 * Non-prompt utilities extracted from the former llm-prompts.ts:
 * response parsing, validation, and JSON cleanup for LLM-based routing.
 */

import type { Complexity, ModelTier, NaxConfig, TddStrategy } from "@/config";
import { NaxError } from "@/errors";
import type { UserStory } from "@/prd/types";
import { extractJsonFromMarkdown, parseLLMJson } from "@/utils/llm-json";
import { determineTestStrategy } from "../classify";
import type { RoutingDecision } from "../router";

/**
 * Validate a parsed routing object and return a clean RoutingDecision.
 *
 * Signature is intentionally narrow — accepts the minimum fields required.
 * This lets ops in `src/operations/` pass their input/ctx slices without
 * widening the operation context type.
 *
 * @throws Error if required fields are missing or values are invalid
 */
export function validateRoutingDecision(
  parsed: Record<string, unknown>,
  config: Pick<NaxConfig, "models" | "tdd">,
  story?: Pick<UserStory, "title" | "description" | "tags">,
): RoutingDecision {
  if (!parsed.complexity || !parsed.modelTier || !parsed.reasoning) {
    throw new NaxError(
      `Missing required fields in LLM response: ${JSON.stringify(parsed)}`,
      "LLM_ROUTING_MISSING_FIELDS",
      {
        stage: "routing",
      },
    );
  }

  const validComplexities: Complexity[] = ["simple", "medium", "complex", "expert"];
  if (!validComplexities.includes(parsed.complexity as Complexity)) {
    throw new NaxError(`Invalid complexity: ${parsed.complexity}`, "LLM_ROUTING_INVALID_COMPLEXITY", {
      stage: "routing",
    });
  }

  const modelTier = parsed.modelTier as string;
  const tierExistsInAnyAgent = Object.values(config.models).some(
    (agentTiers) => typeof modelTier === "string" && Object.hasOwn(agentTiers, modelTier),
  );
  if (!tierExistsInAnyAgent) {
    throw new NaxError(
      `Invalid modelTier: ${modelTier} (not found in any agent's tier map)`,
      "LLM_ROUTING_INVALID_TIER",
      { stage: "routing", modelTier },
    );
  }

  // @design: BUG-045: Derive testStrategy from determineTestStrategy() — single source of truth.
  const tddStrategy: TddStrategy = config.tdd?.strategy ?? "auto";
  const testStrategy = determineTestStrategy(
    parsed.complexity as Complexity,
    story?.title ?? "",
    story?.description ?? "",
    story?.tags ?? [],
    tddStrategy,
  );

  return {
    complexity: parsed.complexity as Complexity,
    modelTier: parsed.modelTier as ModelTier,
    testStrategy,
    reasoning: parsed.reasoning as string,
  };
}

/**
 * Strip markdown code fences from LLM output.
 * @deprecated Use extractJsonFromMarkdown from utils/llm-json directly.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fromFence = extractJsonFromMarkdown(trimmed);
  if (fromFence !== trimmed) return fromFence;
  if (trimmed.startsWith("json")) {
    return trimmed.slice(4).trim();
  }
  return trimmed;
}

/**
 * Parse and validate LLM routing response.
 */
export function parseRoutingResponse(
  output: string,
  story: UserStory,
  config: Pick<NaxConfig, "models" | "tdd">,
): RoutingDecision {
  const parsed = parseLLMJson<Record<string, unknown>>(output);
  return validateRoutingDecision(parsed, config, story);
}

/**
 * Parse batch LLM response into a map of decisions.
 */
export function parseBatchResponse(
  output: string,
  stories: UserStory[],
  config: Pick<NaxConfig, "models" | "tdd">,
): Map<string, RoutingDecision> {
  const parsed = parseLLMJson(output);

  if (!Array.isArray(parsed)) {
    throw new NaxError("Batch LLM response must be a JSON array", "LLM_ROUTING_BATCH_NOT_ARRAY", {
      stage: "routing",
    });
  }

  const decisions = new Map<string, RoutingDecision>();

  for (const entry of parsed) {
    if (!entry.id) {
      throw new NaxError("Batch entry missing 'id' field", "LLM_ROUTING_ENTRY_MISSING_ID", { stage: "routing" });
    }

    const story = stories.find((s) => s.id === entry.id);
    if (!story) {
      throw new NaxError(`Batch entry has unknown story ID: ${entry.id}`, "LLM_ROUTING_UNKNOWN_STORY", {
        stage: "routing",
        storyId: entry.id,
      });
    }

    const decision = validateRoutingDecision(entry, config, story);
    decisions.set(entry.id, decision);
  }

  return decisions;
}
