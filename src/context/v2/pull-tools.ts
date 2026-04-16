/**
 * Context Engine v2 — Pull Tools (Phase 4 + 5)
 *
 * Defines the canonical pull tool descriptors and their server-side handlers.
 * Pull tools are returned by ContextOrchestrator.assemble() alongside push
 * markdown; agent adapters register them on the session so the agent can
 * call them on-demand during execution.
 *
 * Phase 4: query_neighbor for implementer / tdd roles.
 * Phase 5: query_feature_context for reviewer / rectifier roles.
 * Phase 7: query_rag, query_graph, query_kb (separate specs).
 *
 * Budget rules (enforced by PullToolBudget):
 *   - Per-session ceiling: maxCallsPerSession (default 5)
 *   - Per-run ceiling:     maxCallsPerRun (default 50, shared across sessions)
 *   - Per-call ceiling:    maxTokensPerCall (response truncated, default 2048)
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Pull tools
 */

import { NaxError } from "../../errors";
import type { NaxConfig } from "../../config/types";
import type { UserStory } from "../../prd";
import { CodeNeighborProvider } from "./providers/code-neighbor";
import { FeatureContextProviderV2 } from "./providers/feature-context";
import type { ContextRequest, ToolDescriptor } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_CALLS_PER_SESSION = 5;
const DEFAULT_MAX_TOKENS_PER_CALL = 2048;

// ─────────────────────────────────────────────────────────────────────────────
// Descriptor: query_neighbor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical descriptor for the query_neighbor pull tool.
 * Agents receive this definition on the session and can call it to fetch
 * import-graph neighbors for any file path during execution.
 */
export const QUERY_NEIGHBOR_DESCRIPTOR: ToolDescriptor = {
  name: "query_neighbor",
  description:
    "Fetch import-graph neighbors for a file: sibling test, forward imports, " +
    "and reverse dependencies. Call when you need to see related files for a " +
    "specific path that is not in the push context.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Repo-relative path of the file to look up (e.g. 'src/utils/helper.ts')",
      },
      depth: {
        type: "number",
        description: "Traversal depth (default: 1; currently only depth 1 is supported)",
        default: 1,
      },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
  maxCallsPerSession: DEFAULT_MAX_CALLS_PER_SESSION,
  maxTokensPerCall: DEFAULT_MAX_TOKENS_PER_CALL,
};

// ─────────────────────────────────────────────────────────────────────────────
// Descriptor: query_feature_context (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical descriptor for the query_feature_context pull tool.
 * Agents (reviewers, rectifiers) call this to fetch feature context
 * sections on-demand without reading the full push context.
 */
export const QUERY_FEATURE_CONTEXT_DESCRIPTOR: ToolDescriptor = {
  name: "query_feature_context",
  description:
    "Fetch the feature's accumulated context (context.md) to see decisions, " +
    "conventions, and prior learning for this feature. Optionally filter by " +
    "a keyword or section heading. Use when you need to understand the intent " +
    "behind a design decision or check whether a pattern is established.",
  inputSchema: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description:
          "Optional keyword or section heading to filter context sections. " +
          "Returns all content when omitted.",
      },
    },
    additionalProperties: false,
  },
  maxCallsPerSession: DEFAULT_MAX_CALLS_PER_SESSION,
  maxTokensPerCall: DEFAULT_MAX_TOKENS_PER_CALL,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central registry mapping pull tool names to their descriptors.
 * The orchestrator uses this to build ToolDescriptor[] for assemble().
 * Phase 7 providers (RAG, graph, KB) register additional entries here.
 */
export const PULL_TOOL_REGISTRY: Record<string, ToolDescriptor> = {
  query_neighbor: QUERY_NEIGHBOR_DESCRIPTOR,
  query_feature_context: QUERY_FEATURE_CONTEXT_DESCRIPTOR,
};

// ─────────────────────────────────────────────────────────────────────────────
// Budget tracker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared mutable counter for the per-run call ceiling.
 * One RunCallCounter is created per nax run and passed to every PullToolBudget
 * instance so they all draw from the same pool.
 */
export interface RunCallCounter {
  count: number;
}

/** Create a fresh RunCallCounter for the start of a run. */
export function createRunCallCounter(): RunCallCounter {
  return { count: 0 };
}

/**
 * Enforces per-session and per-run pull tool call ceilings.
 * Each agent session creates one PullToolBudget; all share the same
 * RunCallCounter so the per-run ceiling is global across sessions.
 */
export class PullToolBudget {
  private sessionCalls = 0;

  constructor(
    private readonly maxCallsPerSession: number,
    private readonly maxCallsPerRun: number,
    private readonly runCounter: RunCallCounter,
  ) {}

  /**
   * Attempt to consume one call from both the session and run budgets.
   * Throws NaxError with code "PULL_TOOL_BUDGET_EXHAUSTED" when either
   * ceiling is already exhausted before the call.
   */
  consume(): void {
    if (this.sessionCalls >= this.maxCallsPerSession) {
      throw new NaxError(
        "context tool budget exhausted",
        "PULL_TOOL_BUDGET_EXHAUSTED",
        { stage: "pull-tool", scope: "session", limit: this.maxCallsPerSession },
      );
    }
    if (this.runCounter.count >= this.maxCallsPerRun) {
      throw new NaxError(
        "context tool budget exhausted",
        "PULL_TOOL_BUDGET_EXHAUSTED",
        { stage: "pull-tool", scope: "run", limit: this.maxCallsPerRun },
      );
    }
    this.sessionCalls += 1;
    this.runCounter.count += 1;
  }

  isSessionExhausted(): boolean {
    return this.sessionCalls >= this.maxCallsPerSession;
  }

  isRunExhausted(): boolean {
    return this.runCounter.count >= this.maxCallsPerRun;
  }

  get sessionCallsUsed(): number {
    return this.sessionCalls;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler: query_neighbor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Server-side handler for the query_neighbor pull tool.
 *
 * Delegates to CodeNeighborProvider.fetch() with the requested file path.
 * Truncates the response to maxTokensPerCall * 4 characters.
 * Calls budget.consume() before executing — propagates the NaxError if exhausted.
 *
 * @param input           - Tool call arguments from the agent
 * @param workdir         - Working directory for file resolution
 * @param budget          - Budget tracker for this session
 * @param maxTokensPerCall - Per-call token ceiling (chars = tokens × 4)
 */
export async function handleQueryNeighbor(
  input: { filePath: string; depth?: number },
  workdir: string,
  budget: PullToolBudget,
  maxTokensPerCall: number = DEFAULT_MAX_TOKENS_PER_CALL,
): Promise<string> {
  budget.consume();

  const provider = new CodeNeighborProvider();
  const request: ContextRequest = {
    storyId: "_pull-tool",
    workdir,
    stage: "pull-tool",
    role: "implementer",
    budgetTokens: maxTokensPerCall,
    touchedFiles: [input.filePath],
  };
  const result = await provider.fetch(request);

  const content = result.chunks.map((c) => c.content).join("\n\n");
  const maxChars = maxTokensPerCall * 4;
  return content.length > maxChars ? content.slice(0, maxChars) : content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler: query_feature_context (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter feature context content by a keyword or section heading.
 * Splits on level-2 markdown headings (## ...) and keeps sections
 * whose text contains the keyword (case-insensitive).
 * When no ## headings are found, returns the full content unchanged
 * (section-based filtering is not possible on flat content).
 * Returns empty string when sections exist but none match the keyword.
 */
function filterByKeyword(content: string, keyword: string): string {
  const lower = keyword.toLowerCase();
  // Split on level-2 headings; keep each "## ..." block together
  const sections = content.split(/(?=^##\s)/m);
  // No headings — can't section-filter flat content; return all
  if (sections.length <= 1) return content;
  const matched = sections.filter((s) => s.toLowerCase().includes(lower));
  return matched.join("");
}

/**
 * Server-side handler for the query_feature_context pull tool.
 *
 * Delegates to FeatureContextProviderV2.fetch() and optionally filters
 * the returned content by the keyword in input.filter.
 * Truncates the response to maxTokensPerCall * 4 characters.
 * Calls budget.consume() before executing — propagates the NaxError if exhausted.
 *
 * @param input            - Tool call arguments from the agent
 * @param story            - Current user story (needed by FeatureContextProviderV2)
 * @param config           - Nax config (needed by FeatureContextProviderV2)
 * @param workdir          - Working directory for feature-context resolution
 * @param budget           - Budget tracker for this session
 * @param maxTokensPerCall - Per-call token ceiling (chars = tokens × 4)
 */
export async function handleQueryFeatureContext(
  input: { filter?: string },
  story: UserStory,
  config: NaxConfig,
  workdir: string,
  budget: PullToolBudget,
  maxTokensPerCall: number = DEFAULT_MAX_TOKENS_PER_CALL,
): Promise<string> {
  budget.consume();

  const provider = new FeatureContextProviderV2(story, config);
  const request: ContextRequest = {
    storyId: story.id,
    workdir,
    stage: "pull-tool",
    role: "reviewer",
    budgetTokens: maxTokensPerCall,
  };
  const result = await provider.fetch(request);

  let content = result.chunks.map((c) => c.content).join("\n\n");

  if (input.filter && content) {
    content = filterByKeyword(content, input.filter);
  }

  const maxChars = maxTokensPerCall * 4;
  return content.length > maxChars ? content.slice(0, maxChars) : content;
}
