/**
 * Context Engine v2 — query_feature_context pull tool handler (Phase 5).
 *
 * Server-side handler for the query_feature_context pull tool. Delegates to
 * FeatureContextProviderV2.fetch() and optionally filters the returned content
 * by a keyword in `input.filter`. Truncates the response to maxTokensPerCall * 4
 * characters.
 *
 * Calls budget.consume() before executing — propagates the NaxError if exhausted.
 * Emits logger.info with pull-tool invocation metrics for curator ingestion.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Pull tools
 */

import type { ContextToolRuntimeConfig } from "@/config/selectors";
import type { UserStory } from "@/prd";
import { FeatureContextProviderV2 } from "../providers/feature-context";
import type { PullToolBudget } from "../pull-tools";
import { _pullToolsDeps, DEFAULT_MAX_TOKENS_PER_CALL } from "../pull-tools";
import type { ContextRequest } from "../types";

/**
 * Filter feature context content by a keyword or section heading.
 * Splits on any markdown heading of level ≥ 2 (## ..., ### ..., …) and keeps
 * sections whose text contains the keyword (case-insensitive). Providers may
 * re-render top-level `##` headings as `###` when nesting content under a
 * parent chunk heading, so the split must accept both.
 * When no headings are found, returns the full content unchanged (section-based
 * filtering is not possible on flat content). Returns empty string when
 * sections exist but none match the keyword.
 */
function filterByKeyword(content: string, keyword: string): string {
  const lower = keyword.toLowerCase();
  const sections = content.split(/(?=^#{2,}\s)/m);
  if (sections.length <= 1) return content;
  const matched = sections.filter((s) => s.toLowerCase().includes(lower));
  return matched.join("");
}

/**
 * Server-side handler for the query_feature_context pull tool.
 *
 * @param input            - Tool call arguments from the agent
 * @param story            - Current user story (needed by FeatureContextProviderV2)
 * @param config           - Nax config (needed by FeatureContextProviderV2)
 * @param repoRoot         - Working directory for feature-context resolution
 * @param budget           - Budget tracker for this session
 * @param maxTokensPerCall - Per-call token ceiling (chars = tokens × 4)
 * @param featureId        - Feature under assembly, from the ContextBundle.
 *                           Required for dependency-fragment reads: the
 *                           provider early-returns without it, so omitting it
 *                           silently limits this tool to context.md entries.
 */
export async function handleQueryFeatureContext(
  input: { filter?: string },
  story: UserStory,
  config: ContextToolRuntimeConfig,
  repoRoot: string,
  budget: PullToolBudget,
  maxTokensPerCall: number = DEFAULT_MAX_TOKENS_PER_CALL,
  featureId?: string,
): Promise<string> {
  budget.consume();

  const provider = new FeatureContextProviderV2(story, config);
  const request: ContextRequest = {
    storyId: story.id,
    repoRoot,
    packageDir: repoRoot,
    stage: "pull-tool",
    role: "reviewer",
    budgetTokens: maxTokensPerCall,
    ...(featureId !== undefined && { featureId }),
  };
  const result = await provider.fetch(request);

  let content = result.chunks.map((c) => c.content).join("\n\n");

  if (input.filter && content) {
    content = filterByKeyword(content, input.filter);
  }

  const maxChars = maxTokensPerCall * 4;
  const finalContent = content.length > maxChars ? content.slice(0, maxChars) : content;

  budget.record({
    tool: "query_feature_context",
    query: input.filter ?? "",
    at: new Date().toISOString(),
    tokensReturned: Math.ceil(finalContent.length / 4),
    chunkIds: result.chunks.map((c) => c.id),
  });

  const logger = _pullToolsDeps.getLogger();
  logger.info("pull-tool", "invoked", {
    storyId: story.id,
    tool: "query_feature_context",
    keyword: input.filter ?? null,
    resultCount: result.chunks.length,
    resultBytes: finalContent.length,
  });

  return finalContent;
}
