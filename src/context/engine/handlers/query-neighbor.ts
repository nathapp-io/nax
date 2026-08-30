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

import { NaxError } from "@/errors";
import { CodeNeighborProvider } from "../providers/code-neighbor";
import type { PullToolBudget } from "../pull-tools";
import { _pullToolsDeps, DEFAULT_MAX_TOKENS_PER_CALL } from "../pull-tools";
import type { ContextRequest } from "../types";

/**
 * Server-side handler for the query_neighbor pull tool.
 *
 * @param input           - Tool call arguments from the agent (untrusted, validated here)
 * @param repoRoot        - Working directory for file resolution
 * @param budget          - Budget tracker for this session
 * @param maxTokensPerCall - Per-call token ceiling (chars = tokens × 4)
 * @param resolvedTestPatterns - Pre-resolved test patterns (ADR-009 SSOT)
 * @param storyId         - Story id for log correlation
 * @param providerOptions - Optional provider overrides
 */
export async function handleQueryNeighbor(
  // Declared as unknown-valued because this payload is agent-authored JSON,
  // not a typed internal call: tool-runtime hands it straight through from the
  // wire. Typing it `{ filePath: string }` was a claim the caller could not
  // honour, and it hid the missing validation below.
  input: { filePath?: unknown; depth?: unknown },
  repoRoot: string,
  budget: PullToolBudget,
  maxTokensPerCall: number = DEFAULT_MAX_TOKENS_PER_CALL,
  resolvedTestPatterns?: import("@/test-runners").ResolvedTestPatterns,
  storyId?: string,
  providerOptions?: { sourceGlob?: string; maxGlobFiles?: number },
): Promise<string> {
  // Validate BEFORE consuming budget. The agent supplies this payload as free
  // JSON, so `filePath` is only as trustworthy as the preamble that advertised
  // the schema. A missing one previously reached CodeNeighborProvider as
  // touchedFiles: [undefined], matched nothing, and returned "" — the same
  // answer as a genuine file with no neighbors, so a mis-called tool looked
  // like an empty repo. Budget meters context DELIVERED and a rejected call
  // delivers none; the session turn cap already bounds an agent that keeps
  // sending malformed payloads. buildRunInteractionHandler catches this and
  // hands the agent a status="error" block, so it can retry with real args.
  if (typeof input?.filePath !== "string" || input.filePath.trim() === "") {
    throw new NaxError(
      `query_neighbor requires a non-empty string "filePath" (repo-relative path); received ${JSON.stringify(input?.filePath)}`,
      "PULL_TOOL_INVALID_INPUT",
      { stage: "pull-tool", tool: "query_neighbor", ...(storyId ? { storyId } : {}) },
    );
  }

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
