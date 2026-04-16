/**
 * Context Engine v2 — Core Types
 *
 * Defines the ContextRequest → ContextBundle pipeline, the IContextProvider
 * interface, and all supporting types (chunks, manifest, scoring).
 *
 * See: docs/specs/SPEC-context-engine-v2.md
 */

// ─────────────────────────────────────────────────────────────────────────────
// Adapter failure (Phase 5.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Failure descriptor returned (or synthesized) by the agent adapter layer.
 * The runner uses this to decide between escalation (quality) and agent
 * fallback (availability), and passes it to rebuildForAgent() so the new
 * bundle carries a failure-note chunk.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Availability fallback
 */
export interface AdapterFailure {
  /**
   * "availability" — vendor quota, rate-limit, service down, auth error.
   *   Triggers agent fallback (same tier, different agent).
   * "quality" — review/verify rejected output.
   *   Triggers tier escalation by default; agent fallback is opt-in.
   */
  category: "availability" | "quality";
  /**
   * Machine-readable outcome code.
   * availability: fail-quota | fail-service-down | fail-auth | fail-timeout | fail-adapter-error
   * quality:      fail-quality
   */
  outcome:
    | "fail-quota"
    | "fail-service-down"
    | "fail-auth"
    | "fail-timeout"
    | "fail-adapter-error"
    | "fail-quality";
  /** Human-readable description (≤500 chars) for the failure-note chunk */
  message: string;
  /** True when the same agent/tier could succeed on immediate retry */
  retriable: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull tools
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal JSON Schema type alias — no external library required. */
export type JSONSchema = Record<string, unknown>;

/**
 * Descriptor for a pull tool registered with the agent session (Phase 4+).
 * The orchestrator returns these alongside push markdown; agent adapters
 * register them as callable tools on the session.
 */
export interface ToolDescriptor {
  /** Tool identifier exposed to the agent (e.g. "query_neighbor") */
  name: string;
  /** Human-readable description shown to the agent */
  description: string;
  /** JSON Schema for the tool's input arguments */
  inputSchema: JSONSchema;
  /** Maximum calls allowed per agent session before the tool errors */
  maxCallsPerSession: number;
  /** Maximum tokens returned per call (response is truncated to this ceiling) */
  maxTokensPerCall: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chunk kind — controls floor/scoring behavior and provider grouping.
 * "static" and "feature" chunks are always floor-included (budget floor wins).
 */
export type ChunkKind =
  | "static" // CLAUDE.md, .nax/rules/ — project-wide invariants
  | "feature" // context.md for this feature — accumulated learning
  | "session" // session scratch — cross-stage memory (Phase 1)
  | "history" // git history diffs (Phase 3)
  | "neighbor" // import-graph neighbors (Phase 3)
  | "rag" // embedding search results (Phase 7)
  | "graph" // symbol/call graph (Phase 7)
  | "kb"; // external wiki/ADR (Phase 7)

/**
 * Rendering order for the push markdown.
 * Sections are emitted: Project > Feature > Story > Session > Retrieved.
 */
export type ChunkScope = "project" | "feature" | "story" | "session" | "retrieved";

/**
 * Audience tags — used by the role filter to drop irrelevant chunks.
 * "all" means always include regardless of caller role.
 */
export type ChunkRole = "implementer" | "reviewer" | "tdd" | "all";

// ─────────────────────────────────────────────────────────────────────────────
// Core data structures
// ─────────────────────────────────────────────────────────────────────────────

/** A single context chunk produced by a provider and packed into the bundle. */
export interface ContextChunk {
  /** Stable id: `<providerId>:<contentHash8>` */
  id: string;
  /** Provider that produced this chunk */
  providerId: string;
  /** Chunk classification */
  kind: ChunkKind;
  /** Rendering scope (determines section order in push markdown) */
  scope: ChunkScope;
  /** Audience filter — chunk is included only when caller role matches */
  role: ChunkRole[];
  /** Chunk content (markdown) */
  content: string;
  /** Estimated token count */
  tokens: number;
  /** Final score after role × freshness × kind adjustments */
  score: number;
  /** True when chunk is detected as stale (post-GA: staleness signal) */
  stale?: boolean;
  /** Reason recorded in manifest when chunk was floor-included despite budget overflow */
  reason?: string;
}

/**
 * Packing manifest — written alongside ContextBundle for audit and debugging.
 * Records exactly what was included/excluded and why.
 */
export interface ContextManifest {
  /** Unique ID for this assemble() call */
  requestId: string;
  /** Pipeline stage that requested context */
  stage: string;
  /** Total token budget passed in ContextRequest.budgetTokens */
  totalBudgetTokens: number;
  /** Tokens actually used by included chunks + digest */
  usedTokens: number;
  /** IDs of chunks that were packed into the push markdown */
  includedChunks: string[];
  /** Chunks that were excluded, with reason */
  excludedChunks: Array<{
    id: string;
    reason: "below-min-score" | "budget" | "dedupe" | "role-filter" | "stale";
  }>;
  /**
   * Chunk IDs that were floor-included even though they caused the used token
   * count to exceed budgetTokens.  Recorded so callers can see the overage.
   */
  floorItems: string[];
  /** Tokens used by the digest string */
  digestTokens: number;
  /** Wall-clock time for the assemble() call in milliseconds */
  buildMs: number;
  /**
   * Set by rebuildForAgent() when an agent-swap failure triggered the rebuild.
   * Records which agents were involved and why the swap occurred (Phase 5.5).
   */
  rebuildInfo?: {
    priorAgentId: string;
    newAgentId: string;
    failureCategory: AdapterFailure["category"];
    failureOutcome: AdapterFailure["outcome"];
  };
}

/**
 * Output of ContextOrchestrator.assemble() and .rebuildForAgent().
 * Push markdown is injected into the prompt; pull tools are registered
 * on the agent session (Phase 4+).
 */
export interface ContextBundle {
  /** Markdown string injected into the agent prompt (push path) */
  pushMarkdown: string;
  /**
   * Pull tool descriptors to register on the agent session (Phase 4+).
   * Empty array when pull is disabled or the stage has no pull tools configured.
   */
  pullTools: ToolDescriptor[];
  /** Deterministic digest (≤250 tokens) for stage-to-stage threading */
  digest: string;
  /** Audit trail for this bundle */
  manifest: ContextManifest;
  /** Packed chunks (preserved for rebuildForAgent re-render) */
  chunks: ContextChunk[];
  /**
   * Agent id that produced this bundle (Phase 5.5).
   * Set by assemble() when request carries an agent id, and always set by
   * rebuildForAgent(). Used by renderForAgent() to pick the correct framing.
   */
  agentId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input to ContextOrchestrator.assemble().
 * Each pipeline stage builds a ContextRequest describing what it needs.
 */
export interface ContextRequest {
  /** Story being processed */
  storyId: string;
  /** Feature this story belongs to (optional — unattached stories omit this) */
  featureId?: string;
  /** Working directory (repo root or package dir in monorepo) */
  workdir: string;
  /** Pipeline stage name (e.g. "execution", "verify", "review") */
  stage: string;
  /** Caller role — used by role filter and score adjustments */
  role: ChunkRole;
  /**
   * Maximum tokens for the push markdown.
   * Budget floor items (static + feature) are always included even if this
   * is exceeded — manifest records reason: "budget-exceeded-by-floor".
   */
  budgetTokens: number;
  /**
   * Remaining context window space reported by the prompt builder.
   * When provided, the orchestrator uses min(budgetTokens, availableBudgetTokens)
   * as the effective packing ceiling.
   */
  availableBudgetTokens?: number;
  /**
   * Scratch directory paths from sibling TDD sub-sessions (Phase 1).
   * Populated by the pipeline stage from SessionDescriptor.scratchDir values.
   * SessionScratchProvider reads from these paths.
   */
  storyScratchDirs?: string[];
  /**
   * Digest from the prior pipeline stage for progressive threading.
   * Injected into the push markdown so the agent sees a running summary
   * of what earlier stages did.
   */
  priorStageDigest?: string;
  /** Restrict fetch to only these provider IDs (optional, for testing). */
  providerIds?: string[];
  /**
   * Minimum score threshold for noise filtering.
   * Chunks whose adjusted score falls below this are excluded from packing.
   * Sourced from config.context.v2.minScore (default: 0.1).
   * Passed through ContextRequest so callers control it without coupling
   * the orchestrator to NaxConfig.
   */
  minScore?: number;
  /**
   * Files this story touches (from PRD contextFiles or story.relevantFiles).
   * Used by GitHistoryProvider and CodeNeighborProvider (Phase 3).
   */
  touchedFiles?: string[];
  /**
   * Pull tool configuration for this assembly call (Phase 4+).
   * When absent or disabled, assemble() returns an empty pullTools array.
   * Derived by the pipeline stage from config.context.v2.pull.
   */
  pullConfig?: {
    enabled: boolean;
    /** Tool names to activate; empty array means all stage-configured tools are allowed. */
    allowedTools: string[];
    /** Per-session call ceiling (overrides the descriptor's default when provided). */
    maxCallsPerSession: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider interface
// ─────────────────────────────────────────────────────────────────────────────

/** Raw chunk data returned by a provider before scoring/packing. */
export interface RawChunk {
  /** Stable chunk ID (provider is responsible for stable IDs within a feature) */
  id: string;
  /**
   * Provider ID — set by the orchestrator after fetch().
   * Populated via enrichRaw() in orchestrator.ts; not set by the provider itself.
   */
  providerId?: string;
  kind: ChunkKind;
  scope: ChunkScope;
  /** Audience tags */
  role: ChunkRole[];
  content: string;
  tokens: number;
  /** Provider's raw relevance score (0–1 range) */
  rawScore: number;
}

/** What an IContextProvider returns from fetch(). */
export interface ContextProviderResult {
  /** Raw chunks to be scored, deduped, and packed by the orchestrator */
  chunks: RawChunk[];
  /**
   * Reserved for future provider-registered pull tools (Phase 7+).
   * Providers should leave this empty; the orchestrator builds pull tool
   * descriptors from the stage config TOOL_REGISTRY (Phase 4).
   */
  pullTools?: ToolDescriptor[];
}

/**
 * Interface every context provider must implement.
 * Providers are stateless — the orchestrator calls fetch() each time.
 */
export interface IContextProvider {
  /** Unique provider identifier (e.g. "static-rules", "feature-context") */
  readonly id: string;
  /** Chunk kind produced by this provider */
  readonly kind: ChunkKind;
  /**
   * Fetch context chunks for the given request.
   * Must not throw — return empty chunks array on failure and log internally.
   */
  fetch(request: ContextRequest): Promise<ContextProviderResult>;
}
