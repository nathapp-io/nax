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
   * availability: fail-quota | fail-service-down | fail-auth | fail-rate-limit
   * quality:      fail-timeout | fail-adapter-error | fail-quality | fail-unknown
   */
  outcome:
    | "fail-quota"
    | "fail-service-down"
    | "fail-auth"
    | "fail-rate-limit"
    | "fail-timeout"
    | "fail-adapter-error"
    | "fail-quality"
    | "fail-unknown";
  /** Human-readable description (≤500 chars) for the failure-note chunk */
  message: string;
  /** True when the same agent/tier could succeed on immediate retry */
  retriable: boolean;
  /** Seconds to wait before retrying (for rate-limit failures) */
  retryAfterSeconds?: number;
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

/** Effectiveness signal annotated on a chunk post-story (Amendment A AC-45). */
export interface ChunkEffectiveness {
  /** Whether the chunk's advice was followed, contradicted, ignored, or unknown. */
  signal: "followed" | "contradicted" | "ignored" | "unknown";
  /** Short evidence string (review finding text, diff excerpt, etc.) */
  evidence?: string;
}

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
  /** Provider's raw relevance score before adjustments (preserved for traceability) */
  rawScore?: number;
  /** Final score after role × freshness × kind adjustments */
  score: number;
  /** True when chunk is detected as stale (post-GA: staleness signal) */
  stale?: boolean;
  /** True when chunk is a stale candidate (Amendment A AC-46) */
  staleCandidate?: boolean;
  /** Reason recorded in manifest when chunk was floor-included despite budget overflow */
  reason?: string;
  /** Effectiveness signal annotated post-story (Amendment A AC-45) */
  effectiveness?: ChunkEffectiveness;
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
   * All chunk IDs that were floor-packed (static + feature kinds).
   * Every chunk that the budget floor rule included lands here, whether or not
   * it caused an overage. Operators can check this to verify that floor
   * providers actually contributed to the bundle.
   */
  floorItems: string[];
  /**
   * Subset of floorItems whose inclusion pushed usedTokens past budgetTokens.
   * Empty when the floor fit comfortably within budget.
   */
  floorOverageItems?: string[];
  /** Tokens used by the digest string */
  digestTokens: number;
  /** Wall-clock time for the assemble() call in milliseconds */
  buildMs: number;
  /**
   * Per-provider execution outcomes for this assemble() call.
   * Recorded even when a provider fails or returns nothing, so the manifest
   * can explain whether absent context was due to policy, budget, or provider error.
   */
  providerResults?: Array<{
    providerId: string;
    /** "ok" = returned ≥1 chunk; "empty" = succeeded but returned no chunks; "failed" = threw; "timeout" = timed out */
    status: "ok" | "empty" | "failed" | "timeout";
    chunkCount: number;
    durationMs: number;
    /** Total tokens across all chunks returned by this provider */
    tokensProduced: number;
    /**
     * Total LLM cost for this provider call in USD (AC-25).
     * Sum of costUsd across all chunks returned. Absent when the provider
     * reported no chunk costs (i.e. free providers such as git or file-scan).
     */
    costUsd?: number;
    error?: string;
  }>;
  /**
   * Absolute path to the repository root at the time of assembly (AC-60).
   * Populated from ContextRequest.repoRoot. Lets nax context inspect
   * show which repo a manifest came from.
   */
  repoRoot?: string;
  /**
   * Absolute path to the story's package directory at the time of assembly (AC-60).
   * Equals repoRoot for non-monorepo projects (AC-61).
   */
  packageDir?: string;
  /**
   * Set by rebuildForAgent() when an agent-swap failure triggered the rebuild.
   * Records which agents were involved and why the swap occurred (Phase 5.5).
   */
  rebuildInfo?: {
    priorAgentId: string;
    newAgentId: string;
    failureCategory: AdapterFailure["category"];
    failureOutcome: AdapterFailure["outcome"];
    /** Chunk IDs from the prior bundle before the rebuild (AC-39). */
    priorChunkIds: string[];
    /** Chunk IDs in the rebuilt bundle, including any injected failure-note (AC-39). */
    newChunkIds: string[];
  };
  /**
   * Provider IDs in request.providerIds that matched no registered provider (AC-16).
   * Absent when all IDs are known or providerIds is empty.
   */
  unknownProviderIds?: string[];
  /**
   * First 300 chars of each included chunk's content (Amendment A AC-45).
   * Written at assemble() time; used by annotateManifestEffectiveness() post-story
   * to compare chunk content against agent output / diff / review findings.
   * Keyed by chunk ID.
   */
  chunkSummaries?: Record<string, string>;
  /**
   * IDs of included chunks that had staleCandidate: true (Amendment A AC-46).
   * Populated by orchestrator at assemble() time when staleness detection fires.
   */
  staleChunks?: string[];
  /**
   * Per-chunk effectiveness signals written post-story (Amendment A AC-45).
   * Keyed by chunk ID. Written by annotateManifestEffectiveness() after the
   * story pipeline completes; absent until then.
   */
  chunkEffectiveness?: Record<string, ChunkEffectiveness>;
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
// Rebuild options (Phase 5.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for ContextOrchestrator.rebuildForAgent().
 * All fields are optional to preserve backward-compatibility with call sites
 * that only need a digest update without an agent swap.
 *
 * Agent resolution order when newAgentId is absent:
 *   prior.agentId → DEFAULT_REBUILD_AGENT_ID ("claude")
 * This means a bundle that was assembled without an explicit agentId will be
 * re-rendered as claude/markdown-sections, which is the correct behaviour for
 * the common same-agent digest-update case. If the project default agent
 * changes, update DEFAULT_REBUILD_AGENT_ID in orchestrator.ts.
 */
export interface RebuildOptions {
  /** Target agent id for the new session (Phase 5.5 — agent-swap fallback) */
  newAgentId?: string;
  /** Adapter failure that triggered the rebuild (Phase 5.5) */
  failure?: AdapterFailure;
  /** Digest from the prior pipeline stage (optional preamble) */
  priorStageDigest?: string;
  /** Story id for log correlation — passed through to orchestrator warn logs */
  storyId?: string;
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
  /**
   * Absolute path to the repository root where `.nax/` lives (Amendment C AC-54).
   * Replaces the former `workdir` field. Always set. For non-monorepo projects
   * this equals `packageDir`.
   */
  repoRoot: string;
  /**
   * Absolute path to the story's package directory (Amendment C AC-54).
   * Equals `repoRoot` for non-monorepo projects (AC-61 no-op guarantee).
   * In monorepos: `join(repoRoot, story.workdir)`.
   * Providers that scope to package paths (GitHistoryProvider, CodeNeighborProvider)
   * use this field; repo-root providers (StaticRulesProvider, FeatureContextProvider)
   * continue to use `repoRoot`.
   */
  packageDir: string;
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
  /**
   * Agent id that will receive this bundle (Phase 7+).
   * When set, bundle.agentId is populated and renderForAgent() uses this
   * profile for the push markdown framing.
   */
  agentId?: string;
  /**
   * Known capabilities of the target agent (Phase 7+).
   * Used for budget and rendering adjustments when agent metadata is available.
   */
  agentCapabilities?: {
    /** Maximum context window in tokens */
    maxContextTokens: number;
    /** Whether the agent supports tool calls (pull tools) */
    supportsToolCalls: boolean;
  };
  /**
   * Session identity for this assembly (Phase 7+).
   * Matches the ACP session name so the manifest can be correlated with session logs.
   */
  sessionId?: string;
  /**
   * Failure hints from prior stages (Phase 7+).
   * Passed to providers so they can surface recovery-relevant context
   * (e.g. a rectify provider surfacing prior failure patterns).
   */
  failureHints?: string[];
  /**
   * Determinism mode (AC-24).
   * When true, the orchestrator skips providers that declare `deterministic: false`.
   * Ensures two runs with identical inputs produce identical push blocks.
   * Sourced from config.context.v2.deterministic.
   */
  deterministic?: boolean;
  /**
   * Plan digest score multiplier (Amendment B AC-51).
   * When > 1.0 and priorStageDigest is present, the orchestrator injects the plan
   * digest as a scored RawChunk (id: "plan-digest:<hash>") with
   * rawScore = 0.9 * planDigestBoost instead of using raw "## Prior Stage Summary" rendering.
   * Sourced from StageContextConfig.planDigestBoost for single-session modes.
   */
  planDigestBoost?: number;
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
  /**
   * LLM cost for producing this chunk in USD (AC-25).
   * Only set by providers that invoke an LLM to generate context (e.g. KB-retrieval).
   * Free providers (git, file-scan) omit this field.
   */
  costUsd?: number;
  /**
   * True when this chunk is a staleness candidate (Amendment A AC-46).
   * Set by FeatureContextProviderV2 when an entry is older than maxStoryAge
   * or contradicted by a newer entry in the same section (AC-47).
   * The scorer applies scoreMultiplier to downweight stale chunks.
   */
  staleCandidate?: boolean;
  /**
   * Score multiplier applied by the scorer when staleCandidate is true.
   * Comes from config.context.v2.staleness.scoreMultiplier (default: 0.4).
   */
  scoreMultiplier?: number;
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
   * Whether this provider produces deterministic output (AC-24).
   * Absent or true = deterministic. false = non-deterministic (e.g. LLM-based, random sampling).
   * When ContextRequest.deterministic is true, non-deterministic providers are skipped.
   */
  readonly deterministic?: boolean;
  /**
   * Fetch context chunks for the given request.
   * Must not throw — return empty chunks array on failure and log internally.
   *
   * Concurrency contract: fetch() must be safe under concurrent invocation with
   * distinct ContextRequest values. The orchestrator calls providers in parallel
   * within a single assemble pass, and a future plugin cache (Finding 5) will
   * share provider instances across parallel stories. Implementations must not
   * rely on per-call mutable state on the provider instance.
   */
  fetch(request: ContextRequest): Promise<ContextProviderResult>;
}
