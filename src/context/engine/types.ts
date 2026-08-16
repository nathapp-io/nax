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
   * availability: fail-quota | fail-service-down | fail-auth | fail-rate-limit | fail-aborted | fail-stale
   * quality:      fail-timeout | fail-adapter-error | fail-quality | fail-unknown
   *
   * `fail-aborted` — the run was cancelled via AgentRunOptions.abortSignal
   * (shutdown in progress). Not retriable; fallback chains should not fire.
   * `fail-stale` — either (a) the idle watchdog cancelled due to no stream activity
   * within the configured idle timeout, or (b) the agent finished cleanly with empty
   * output. The `reason` field distinguishes: "idle-watchdog" vs "empty-output".
   * Retriable up to maxRetryAttempts.
   */
  outcome:
    | "fail-quota"
    | "fail-service-down"
    | "fail-auth"
    | "fail-rate-limit"
    | "fail-aborted"
    | "fail-stale"
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
  /**
   * Observability tag — distinguishes outcome subtypes. No semantic effect on retry/swap.
   * Examples: "idle-watchdog" (fail-stale from idle watchdog cancellation),
   * "empty-output" (fail-stale synthesized when agent returned no output).
   */
  reason?: string;
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
 * "static", "feature", and "test-coverage" chunks are always floor-included (budget floor wins).
 */
export type ChunkKind =
  | "static" // CLAUDE.md, .nax/rules/ — project-wide invariants
  | "feature" // context.md for this feature — accumulated learning
  | "test-coverage" // test coverage data (US-002 foundation)
  | "diagnostics" // tool diagnostics (US-002 — lint/typecheck failure provenance)
  | "prior-failure" // historic failures from prior runs (US-003 — deterministic, scope story)
  | "lint-config" // package lint configuration (US-004 — deterministic, scope project)
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
// Manifest types (extracted to manifest-types.ts)
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ChunkEffectiveness,
  ContextChunk,
  ContextManifest,
  ProviderBudgetPressure,
  ProviderScopingReport,
} from "./manifest-types";
export type { ChunkEffectiveness, ContextChunk, ContextManifest, ProviderBudgetPressure, ProviderScopingReport };

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
  /**
   * Feature the bundle was assembled for. Carried so the pull-tool runtime can
   * rebuild an equivalent ContextRequest: `query_feature_context` constructs
   * its own request, and without a featureId the fragment read path early-
   * returns, leaving the pull tool blind to dependency fragments the push path
   * delivers. The bundle is already threaded to the runtime, so riding along
   * here avoids plumbing a new argument through build-hop-callback.
   *
   * Preserved across rebuild() — dropping it there would silently disable
   * fragments for every post-swap hop.
   */
  featureId?: string;
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
  /**
   * Runtime output directory where run artefacts (metrics.json, cost/, prompt-audit/)
   * are written. Defaults to `~/.nax/<projectKey>`; overridable via
   * `config.outputDir` (absolute or `~/...`).
   *
   * Sourced from `runtime.outputDir` at stage assembly. Read-side providers
   * (e.g. PriorRunFailureProvider) MUST use this to find metrics.json — the
   * write side (`saveRunMetrics(runtime.outputDir, …)`) writes here, never
   * at `repoRoot` (BUG-1 — see
   * docs/20260816-review-since-0.80.0-canary.3.md).
   *
   * Optional for backward compat with callers/tests that predate the field;
   * providers reading metrics.json fall back to `repoRoot` when omitted.
   */
  outputDir?: string;
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
   * Additional provider IDs configured for this stage via context.v2.stages.
   * Merged additively with the built-in stage allowlist.
   */
  extraProviderIds?: string[];
  /**
   * Minimum score threshold for noise filtering.
   * Chunks whose adjusted score falls below this are excluded from packing.
   * Sourced from config.context.v2.minScore (default: 0.1).
   * Passed through ContextRequest so callers control it without coupling
   * the orchestrator to NaxConfig.
   */
  minScore?: number;
  /**
   * Per-provider fetch timeout in ms. A provider exceeding it is dropped; the
   * orchestrator warns but does not fail the stage (spec AC-5). Sourced from
   * `config.context.v2.stages[stage].providerTimeoutMs` falling back to
   * `config.context.v2.providerTimeoutMs` (default 5000). Absent = engine default.
   */
  providerTimeoutMs?: number;
  /**
   * Files this story touches (from PRD contextFiles or story.relevantFiles).
   * Used by GitHistoryProvider and CodeNeighborProvider (Phase 3).
   */
  touchedFiles?: string[];
  /**
   * Complete evidence set of files a story touches (PRD contextFiles +
   * expectedFiles + git diff). Used by SCOPING decisions only — providers
   * that fetch content read `touchedFiles` instead. Resolved by
   * `resolveScopeFiles(ctx)` and threaded through `StageAssembleOptions.scopeFiles`.
   */
  scopeFiles?: string[];
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
  /**
   * Resolved test-file patterns for this story (ADR-009 SSOT).
   * Resolved once per request via resolveTestFilePatterns(config, workdir, packageDir)
   * and threaded through so providers never classify test files via inline regex.
   * Providers that need to know "is this a test file?" or "where is the sibling test?"
   * consult this field instead of hardcoding extensions or directory names.
   */
  resolvedTestPatterns?: import("@/test-runners").ResolvedTestPatterns;
  /**
   * Pre-built naxIgnore index for this run.
   * When present, CodeNeighborProvider passes the per-package matchers to the
   * glob dep so user-defined .naxignore patterns suppress files from the
   * reverse-dep scan.
   */
  naxIgnoreIndex?: import("@/utils/path-filters").NaxIgnoreIndex;
  /**
   * Per-provider effectiveness weights derived from prior manifests (US-004).
   * Sourced from `deriveProviderWeights(await loadFeatureManifests({ featureId, projectDir })
   * .then(stored => stored.map(s => s.manifest)))` — set by the V2 context
   * stage's own request, and by every request `assembleForStage()` builds for
   * the stages it serves (execution, rectify, tdd, review). When present,
   * `scoreChunk` multiplies the chunk's score by the weight keyed on
   * `chunk.providerId` (identity = 1.0 when omitted).
   */
  providerWeights?: Record<string, number>;
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
  /**
   * Inherited file-scope attribution carrier (US-002).
   *
   * Populated by `StaticRulesProvider.fetch()` from the owning rule's
   * `appliesTo:` frontmatter (per-section, since each section inherits the
   * rule's appliesTo). Other providers omit it today — those chunks keep
   * whole-diff behaviour. Read by `buildManifest()` and persisted onto
   * `ContextManifest.chunkScopePaths` so downstream attribution can map
   * chunk IDs back to the files they are scoped to.
   */
  scopePaths?: string[];
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
  /**
   * Budget pressure reported by the provider when it exceeded its own token
   * budget. Omitted when the provider fit inside its budget. When set, surfaces
   * silent loss that would otherwise be invisible downstream (US-003).
   */
  budgetPressure?: ProviderBudgetPressure;
  /**
   * Rule-scoping outcome reported by providers that apply stage/appliesTo
   * filters to canonical rules (US — rule-scoping). Omitted by providers
   * that don't scope rules.
   */
  scopingReport?: ProviderScopingReport;
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
   * Exception: StaticRulesProvider deliberately throws NeutralityLintError
   * to signal a fail-closed condition (the canonical rules store failed
   * lint). The orchestrator escalates specifically on that error type (not
   * on `kind: "static"` generally — see orchestrator.ts fetch loop) instead
   * of the usual soft-skip, aborting assemble() rather than silently
   * proceeding with zero rules. Callers of assemble() (runV2Path in
   * pipeline/stages/context.ts) fall back to the v1 context path on that
   * escalation specifically. Every other error must still honor the "never
   * throw" contract.
   *
   * Concurrency contract: fetch() must be safe under concurrent invocation with
   * distinct ContextRequest values. The orchestrator calls providers in parallel
   * within a single assemble pass, and a future plugin cache (Finding 5) will
   * share provider instances across parallel stories. Implementations must not
   * rely on per-call mutable state on the provider instance.
   */
  fetch(request: ContextRequest, signal?: AbortSignal): Promise<ContextProviderResult>;
}
