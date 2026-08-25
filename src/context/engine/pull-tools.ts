/**
 * Context Engine v2 — Pull Tools (Phase 4 + 5)
 *
 * Defines the canonical pull tool descriptors, the central registry, and the
 * shared budget tracker. Server-side handlers live in `./handlers/` — one file
 * per family (query_neighbor, query_feature_context, query_scratch). Pull tool
 * descriptors are returned by ContextOrchestrator.assemble() alongside push
 * markdown; agent adapters register them on the session so the agent can call
 * them on-demand during execution.
 *
 * Phase 4: query_neighbor for implementer / tdd roles.
 * Phase 5: query_feature_context for reviewer / rectifier roles.
 * US-005: query_scratch for retry / rectification on-demand reads.
 * Phase 7: query_rag, query_graph, query_kb (separate specs).
 *
 * Budget rules (enforced by PullToolBudget):
 *   - Per-session ceiling: maxCallsPerSession (default 5)
 *   - Per-run ceiling:     maxCallsPerRun (default 50, shared across sessions)
 *   - Per-call ceiling:    maxTokensPerCall (response truncated, default 2048)
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Pull tools
 */

import { ContextV2ConfigSchema } from "@/config";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import type { ScratchEntry } from "@/session";
import { scratchFilePath } from "@/session";
import type { ToolDescriptor } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies (injectable for testing)
// ─────────────────────────────────────────────────────────────────────────────

export const _pullToolsDeps = {
  getLogger,
  /** Read a file's text; returns "" when absent. Used by the query_scratch handler. */
  readFile: async (path: string): Promise<string> => {
    const f = Bun.file(path);
    return (await f.exists()) ? f.text() : Promise.resolve("");
  },
  /** Existence check for a file path. Used by the query_scratch handler. */
  fileExists: async (path: string): Promise<boolean> => Bun.file(path).exists(),
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared per-session ceiling every descriptor starts from. Exported because the
 * orchestrator needs it to tell "the operator configured a ceiling" apart from
 * "the schema supplied its default" — `config.context.v2.pull.maxCallsPerSession`
 * always has a value, so the two are otherwise indistinguishable downstream.
 *
 * Derived from the schema rather than hand-written: a second literal that must
 * silently agree with a Zod default is the same rot this module's sibling config
 * change removes. If they diverged, an unconfigured run would read as configured
 * and clobber every descriptor's own ceiling.
 */
export const DEFAULT_MAX_CALLS_PER_SESSION = ContextV2ConfigSchema.parse({}).pull.maxCallsPerSession;
export const DEFAULT_MAX_TOKENS_PER_CALL = 2048;

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
          "Optional keyword or section heading to filter context sections. " + "Returns all content when omitted.",
      },
    },
    additionalProperties: false,
  },
  maxCallsPerSession: DEFAULT_MAX_CALLS_PER_SESSION,
  maxTokensPerCall: DEFAULT_MAX_TOKENS_PER_CALL,
};

// ─────────────────────────────────────────────────────────────────────────────
// Descriptor: query_scratch (US-005)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical descriptor for the query_scratch pull tool.
 *
 * Agents (retriers, implementers on a retry) call this to fetch the per-story
 * record of what actually broke — verify-result, tool-diagnostics, rectify
 * attempts — without forcing every entry into push context. The handler reads
 * the same storyScratchDirs the push providers (SessionScratchProvider,
 * ToolDiagnosticsProvider) already use, so the pull-style read sees the same
 * data as the push-style render.
 *
 * Budget: per-session ceiling is the descriptor default (shared with
 * query_neighbor / query_feature_context); enforcement is the existing
 * pull-tool budget path. `query_scratch` invoked past its ceiling throws the
 * same PULL_TOOL_BUDGET_EXHAUSTED error as query_neighbor.
 *
 * Filter args are both optional: `kind` narrows by entry kind, `limit` caps
 * the number of entries returned. Most-recent entries are returned first.
 *
 * Failure handling: a missing scratch dir or no-match filter returns a
 * no-entries message — never throws for expected absence.
 */
export const QUERY_SCRATCH_DESCRIPTOR: ToolDescriptor = {
  name: "query_scratch",
  description:
    "Fetch on-demand records of what actually broke for this story — verify-result, " +
    "tool-diagnostics, rectify-attempt entries from the session scratch JSONL. " +
    "Use to read the record of a prior failure without forcing every entry into " +
    "the push context. Optional: filter by `kind` (e.g. 'tool-diagnostics'), cap " +
    "the response with `limit` (most-recent N entries).",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description:
          "Optional scratch entry kind to filter by. When omitted, all " + "renderable entry kinds are returned.",
      },
      limit: {
        type: "number",
        description: "Maximum number of entries to return (most-recent first).",
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
  query_scratch: QUERY_SCRATCH_DESCRIPTOR,
};

// ─────────────────────────────────────────────────────────────────────────────
// Budget tracker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared mutable counter for the per-run call ceiling.
 * One RunCallCounter is created per story attempt (not per run, despite the name) and passed to every PullToolBudget
 * instance so they all draw from the same pool.
 */
/**
 * One recorded pull-tool invocation. Shape is fixed by
 * SPEC-context-engine-v2.md:245 (ContextManifest.pullCalls).
 */
export interface PullCallRecord {
  /** Tool name, e.g. "query_neighbor" */
  tool: string;
  /** The tool's primary argument — the file path or filter the agent asked for */
  query: string;
  /** ISO timestamp of the invocation */
  at: string;
  /** Estimated tokens in the (possibly truncated) response */
  tokensReturned: number;
  /** Ids of the chunks the provider returned for this call */
  chunkIds: string[];
}

export interface RunCallCounter {
  count: number;
  /**
   * Per-invocation records (AC-18). Shares the counter's lifetime, so it is
   * scoped exactly as `count` is and needs no separate threading. Bounded by
   * `maxCallsPerRun`, since `record()` is only reachable after `consume()`.
   */
  calls: PullCallRecord[];
}

/** Create a fresh RunCallCounter for the start of a run. */
export function createRunCallCounter(): RunCallCounter {
  return { count: 0, calls: [] };
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
      throw new NaxError("context tool budget exhausted", "PULL_TOOL_BUDGET_EXHAUSTED", {
        stage: "pull-tool",
        scope: "session",
        limit: this.maxCallsPerSession,
      });
    }
    if (this.runCounter.count >= this.maxCallsPerRun) {
      throw new NaxError("context tool budget exhausted", "PULL_TOOL_BUDGET_EXHAUSTED", {
        stage: "pull-tool",
        scope: "run",
        limit: this.maxCallsPerRun,
      });
    }
    this.sessionCalls += 1;
    this.runCounter.count += 1;
  }

  /**
   * Record a completed invocation. Called by handlers AFTER the response is
   * known, so `consume()`'s throw path can never leave a phantom record.
   */
  record(entry: PullCallRecord): void {
    this.runCounter.calls.push(entry);
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
// Handler entry — re-exported for the runners + runtime. The implementations
// live in `./handlers/<family>.ts` so each handler family can grow
// independently without bloating the descriptor / budget module.
// ─────────────────────────────────────────────────────────────────────────────

export { handleQueryFeatureContext } from "./handlers/query-feature-context";
// STYLE-6 fix: do NOT re-export handler implementations from this module.
// pull-tools.ts defines descriptors and shared infrastructure; the handlers
// live in ./handlers/<family>.ts. Re-exporting `handleQueryScratch` here
// creates a circular module reference (`pull-tools.ts` →
// `handlers/query-scratch.ts` → `pull-tools.ts` for `_pullToolsDeps`),
// which was previously benign only because every reference is inside a
// function body and never at module top level. Importing the handlers
// directly from `./handlers/query-scratch` is one-line per consumer and
// removes the latent TDZ risk. Callers previously using the re-export
// (`./pull-tools`) now import from `./handlers/query-scratch`.
export { handleQueryNeighbor } from "./handlers/query-neighbor";
export type { QueryScratchOptions } from "./handlers/query-scratch";
export type { ScratchEntry };
// Re-export scratch-file path helpers and the ScratchEntry type so handler
// implementations can use them without re-importing from session/scratch-writer.
export { scratchFilePath };
