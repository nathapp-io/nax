/**
 * AC Refinement Module
 *
 * Takes raw PRD acceptanceCriteria strings and refines them into concrete,
 * testable assertions using an LLM call via adapter.complete().
 */

import type { AgentAdapter } from "../agents";
import { createAgentRegistry } from "../agents/registry";
import { resolveModelForAgent } from "../config";
import { getLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import type { RefinedCriterion, RefinementContext } from "./types";

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

      const adapter = createAgentRegistry(config).getAgent(config.autoMode.defaultAgent);
      if (!adapter) throw new Error(`Agent "${config.autoMode.defaultAgent}" not found`);

      return adapter.complete(...args);
    },
  } satisfies Pick<AgentAdapter, "complete">,
};

/**
 * Strategy-specific context for the refinement prompt.
 */
export interface RefinementPromptOptions {
  /** Test strategy — controls strategy-specific prompt instructions */
  testStrategy?: "unit" | "component" | "cli" | "e2e" | "snapshot";
  /** Test framework — informs LLM which testing library syntax to use */
  testFramework?: string;
}

/**
 * Build the LLM prompt for refining acceptance criteria.
 *
 * @param criteria - Raw AC strings from PRD
 * @param codebaseContext - File tree / dependency context
 * @param options - Optional strategy/framework context
 * @returns Formatted prompt string
 */
export function buildRefinementPrompt(
  criteria: string[],
  codebaseContext: string,
  options?: RefinementPromptOptions,
): string {
  const criteriaList = criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const strategySection = buildStrategySection(options);
  const refinedExample = buildRefinedExample(options?.testStrategy);

  return `You are an acceptance criteria refinement assistant. Your task is to convert raw acceptance criteria into concrete, machine-verifiable assertions.

CODEBASE CONTEXT:
${codebaseContext}
${strategySection}
ACCEPTANCE CRITERIA TO REFINE:
${criteriaList}

For each criterion, produce a refined version that is concrete and automatically testable where possible.
Respond with ONLY a JSON array (no markdown code fences):
[{
  "original": "<exact original criterion text>",
  "refined": "<concrete, machine-verifiable description>",
  "testable": true,
  "storyId": ""
}]

Rules:
- "original" must match the input criterion text exactly
- "refined" must be a concrete assertion (e.g., ${refinedExample})
- "testable" is false only if the criterion cannot be automatically verified (e.g., "UX feels responsive", "design looks good")
- "storyId" leave as empty string — it will be assigned by the caller
- Respond with ONLY the JSON array`;
}

/**
 * Build strategy-specific instructions section for the prompt.
 */
function buildStrategySection(options?: RefinementPromptOptions): string {
  if (!options?.testStrategy) {
    return "";
  }

  const framework = options.testFramework ? ` Use ${options.testFramework} testing library syntax.` : "";

  switch (options.testStrategy) {
    case "component":
      return `
TEST STRATEGY: component
Focus assertions on rendered output visible on screen — text content, visible elements, and screen state.
Assert what the user sees rendered in the component, not what internal functions produce.${framework}
`;
    case "cli":
      return `
TEST STRATEGY: cli
Focus assertions on stdout and stderr text output from the CLI command.
Assert about terminal output content, exit codes, and standard output/standard error streams.${framework}
`;
    case "e2e":
      return `
TEST STRATEGY: e2e
Focus assertions on HTTP response content — status codes, response bodies, and endpoint behavior.
Assert about HTTP responses, status codes, and API endpoint output.${framework}
`;
    default:
      return framework ? `\nTEST FRAMEWORK: ${options.testFramework}\n` : "";
  }
}

/**
 * Build the "refined" example string based on the test strategy.
 */
function buildRefinedExample(testStrategy?: RefinementPromptOptions["testStrategy"]): string {
  switch (testStrategy) {
    case "component":
      return '"Text content visible on screen matches expected", "Rendered output contains expected element"';
    case "cli":
      return '"stdout contains expected text", "stderr is empty on success", "exit code is 0"';
    case "e2e":
      return '"HTTP status 200 returned", "Response body contains expected field", "Endpoint returns JSON"';
    default:
      return '"Array of length N returned", "HTTP status 200 returned"';
  }
}

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
    const parsed: unknown = JSON.parse(response);

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
export async function refineAcceptanceCriteria(
  criteria: string[],
  context: RefinementContext,
): Promise<RefinedCriterion[]> {
  if (criteria.length === 0) {
    return [];
  }

  const { storyId, featureName, workdir, codebaseContext, config, testStrategy, testFramework } = context;
  const logger = getLogger();

  const modelTier = config.acceptance?.model ?? "fast";
  const modelDef = resolveModelForAgent(
    config.models,
    config.autoMode.defaultAgent,
    modelTier,
    config.autoMode.defaultAgent,
  );
  const prompt = buildRefinementPrompt(criteria, codebaseContext, { testStrategy, testFramework });

  let response: string;

  try {
    const completeResult = await _refineDeps.adapter.complete(prompt, {
      jsonMode: true,
      maxTokens: 4096,
      model: modelDef.model,
      config,
      featureName,
      storyId,
      workdir,
      sessionRole: "refine",
      timeoutMs: config.acceptance?.timeoutMs ?? 120_000,
    });
    response = typeof completeResult === "string" ? completeResult : completeResult.output;
  } catch (error) {
    const reason = errorMessage(error);
    logger.warn("refinement", "adapter.complete() failed, falling back to original criteria", {
      storyId,
      error: reason,
    });
    return fallbackCriteria(criteria, storyId);
  }

  const parsed = parseRefinementResponse(response, criteria);

  return parsed.map((item) => ({
    ...item,
    storyId: item.storyId || storyId,
  }));
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
