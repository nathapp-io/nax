/**
 * AC Refinement Module
 *
 * Takes raw PRD acceptanceCriteria strings and refines them into concrete,
 * testable assertions using an LLM call via adapter.complete().
 */

import type { AgentAdapter } from "../agents";
import { resolveDefaultAgent } from "../agents";
import { createAgentRegistry } from "../agents/registry";
import { resolveConfiguredModel } from "../config";
import { getLogger } from "../logger";
import { AcceptancePromptBuilder } from "../prompts";
import { errorMessage } from "../utils/errors";
import { extractJsonFromMarkdown, stripTrailingCommas } from "../utils/llm-json";
import type { RefineResult, RefinedCriterion, RefinementContext } from "./types";

/**
 * Injectable dependencies — allows tests to mock adapter.complete()
 * without needing the claude binary.
 *
 * @internal
 */
export const _refineDeps = {
  adapter: {
    complete: async (...args: Parameters<AgentAdapter["complete"]>) => {
      const options = args[1];
      const config = options?.config;
      if (!config) throw new Error("Refinement adapter requires config");

      const resolvedModel = resolveConfiguredModel(
        config.models,
        resolveDefaultAgent(config),
        config.acceptance?.model ?? "fast",
        resolveDefaultAgent(config),
      );
      const adapter = createAgentRegistry(config).getAgent(resolvedModel.agent);
      if (!adapter) throw new Error(`Agent "${resolvedModel.agent}" not found`);

      return adapter.complete(...args);
    },
  } satisfies Pick<AgentAdapter, "complete">,
};

/**
 * Parse the LLM JSON response into RefinedCriterion[].
 *
 * Falls back gracefully: if JSON is malformed or a criterion is missing,
 * uses the original text with testable: true.
 *
 * @param response - Raw LLM response text
 * @param criteria - Original criteria strings (used as fallback)
 * @returns Array of refined criteria
 */
export function parseRefinementResponse(response: string, criteria: string[]): RefinedCriterion[] {
  if (!response || !response.trim()) {
    return fallbackCriteria(criteria);
  }

  try {
    const fromFence = extractJsonFromMarkdown(response);
    const cleaned = stripTrailingCommas(fromFence !== response ? fromFence : response);
    const parsed: unknown = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      return fallbackCriteria(criteria);
    }

    return (parsed as RefinedCriterion[]).map((item, i) => ({
      original: typeof item.original === "string" && item.original.length > 0 ? item.original : (criteria[i] ?? ""),
      refined: typeof item.refined === "string" && item.refined.length > 0 ? item.refined : (criteria[i] ?? ""),
      testable: typeof item.testable === "boolean" ? item.testable : true,
      storyId: typeof item.storyId === "string" ? item.storyId : "",
    }));
  } catch {
    return fallbackCriteria(criteria);
  }
}

/**
 * Refine raw acceptance criteria strings into concrete, testable assertions.
 *
 * @param criteria - Raw AC strings from PRD
 * @param context - Refinement context (storyId, codebase context, config)
 * @returns Promise resolving to array of refined criteria
 */
export async function refineAcceptanceCriteria(criteria: string[], context: RefinementContext): Promise<RefineResult> {
  if (criteria.length === 0) {
    return { criteria: [], costUsd: 0 };
  }

  const {
    storyId,
    featureName,
    workdir,
    codebaseContext,
    config,
    testStrategy,
    testFramework,
    storyTitle,
    storyDescription,
  } = context;
  const logger = getLogger();

  const resolvedModel = resolveConfiguredModel(
    config.models,
    resolveDefaultAgent(config),
    config.acceptance?.model ?? "fast",
    resolveDefaultAgent(config),
  );
  const prompt = new AcceptancePromptBuilder().buildRefinementPrompt(criteria, codebaseContext, {
    testStrategy,
    testFramework,
    storyTitle,
    storyDescription,
  });

  let response: string;

  try {
    const completeOpts = {
      jsonMode: true,
      maxTokens: 4096,
      model: resolvedModel.modelDef.model,
      config,
      featureName,
      storyId,
      workdir,
      sessionRole: "refine",
      timeoutMs: config.acceptance?.timeoutMs ?? 120_000,
    } as const;
    const completeResult = context.agentManager
      ? (await context.agentManager.completeWithFallback(prompt, completeOpts)).result
      : await _refineDeps.adapter.complete(prompt, completeOpts);
    const costUsd = typeof completeResult === "string" ? 0 : (completeResult.costUsd ?? 0);
    response = typeof completeResult === "string" ? completeResult : completeResult.output;

    const parsed = parseRefinementResponse(response, criteria);
    return {
      criteria: parsed.map((item) => ({ ...item, storyId: item.storyId || storyId })),
      costUsd,
    };
  } catch (error) {
    const reason = errorMessage(error);
    logger.warn("refinement", "adapter.complete() failed, falling back to original criteria", {
      storyId,
      error: reason,
    });
    return { criteria: fallbackCriteria(criteria, storyId), costUsd: 0 };
  }
}

/**
 * Build fallback RefinedCriterion[] using original criterion text.
 */
function fallbackCriteria(criteria: string[], storyId = ""): RefinedCriterion[] {
  return criteria.map((c) => ({
    original: c,
    refined: c,
    testable: true,
    storyId,
  }));
}
