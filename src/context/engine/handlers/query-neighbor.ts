/**
 * Context Engine v2 — query_neighbor pull tool handler.
 *
 * Server-side handler for the query_neighbor pull tool. Delegates to
 * CodeNeighborProvider.fetch() with the requested file path and truncates
 * the response to maxTokensPerCall * 4 characters.
 *
 * Calls budget.consume() before executing — propagates the NaxError if exhausted.
 * Emits logger.info with pull-tool invocation metrics for curator ingestion.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Pull tools
 */

import { CodeNeighborProvider } from "../providers/code-neighbor";
import type { PullToolBudget } from "../pull-tools";
import { _pullToolsDeps, DEFAULT_MAX_TOKENS_PER_CALL } from "../pull-tools";
import type { ContextRequest } from "../types";

/**
 * Server-side handler for the query_neighbor pull tool.
 *
 * @param input           - Tool call arguments from the agent
 * @param repoRoot        - Working directory for file resolution
 * @param budget          - Budget tracker for this session
 * @param maxTokensPerCall - Per-call token ceiling (chars = tokens × 4)
 * @param resolvedTestPatterns - Pre-resolved test patterns (ADR-009 SSOT)
 * @param storyId         - Story id for log correlation
 * @param providerOptions - Optional provider overrides
 */
export async function handleQueryNeighbor(
  input: { filePath: string; depth?: number },
  repoRoot: string,
  budget: PullToolBudget,
  maxTokensPerCall: number = DEFAULT_MAX_TOKENS_PER_CALL,
  resolvedTestPatterns?: import("@/test-runners").ResolvedTestPatterns,
  storyId?: string,
  providerOptions?: { sourceGlob?: string; maxGlobFiles?: number },
): Promise<string> {
  budget.consume();

  const provider = new CodeNeighborProvider(providerOptions ?? {});
  // NOTE: packageDir intentionally equals repoRoot. Callers pass the story's
  // already-resolved package dir AS repoRoot (build-hop-callback -> call.ts ->
  // execution.ts -> iteration-runner, which joins story.workdir), so this IS
  // package-scoped. Two attempts to "scope" it further were both wrong: joining
  // story.workdir again double-joins in monorepos, and splitting repoRoot from
  // packageDir redirects the cross-package scan at the main checkout under
  // storyIsolation: "worktree". Do not "fix" this without a worktree test.
  const request: ContextRequest = {
    storyId: storyId ?? "_pull-tool",
    repoRoot,
    packageDir: repoRoot,
    stage: "pull-tool",
    role: "implementer",
    budgetTokens: maxTokensPerCall,
    touchedFiles: [input.filePath],
    ...(resolvedTestPatterns && { resolvedTestPatterns }),
  };
  const result = await provider.fetch(request);

  const content = result.chunks.map((c) => c.content).join("\n\n");
  const maxChars = maxTokensPerCall * 4;
  const truncated = content.length > maxChars;
  const finalContent = truncated ? content.slice(0, maxChars) : content;

  budget.record({
    tool: "query_neighbor",
    query: input.filePath,
    at: new Date().toISOString(),
    tokensReturned: Math.ceil(finalContent.length / 4),
    chunkIds: result.chunks.map((c) => c.id),
  });

  const logger = _pullToolsDeps.getLogger();
  const logData: Record<string, unknown> = {
    storyId: storyId ?? "_pull-tool",
    tool: "query_neighbor",
    filePath: input.filePath,
    packageDir: repoRoot,
    resultCount: result.chunks.length,
    resultBytes: finalContent.length,
  };
  if (truncated) {
    logData.truncated = true;
  }
  logger.info("pull-tool", "invoked", logData);

  return finalContent;
}
