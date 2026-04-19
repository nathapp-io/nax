/**
 * Runtime Configuration Type Definitions
 *
 * All configuration interfaces for nax runtime behavior,
 * including execution limits, quality gates, and feature settings.
 */

import type { ConstitutionConfig } from "../constitution/types";
import type { ReviewConfig } from "../review/types";
import type {
  Complexity,
  ConfiguredModel,
  LlmRoutingMode,
  ModelTier,
  ModelsConfig,
  RoutingStrategyName,
  TddStrategy,
} from "./schema-types";

export interface EscalationEntry {
  from: string;
  to: string;
}

/** Auto mode configuration */
export interface AutoModeConfig {
  enabled: boolean;
  /** Default agent to use */
  defaultAgent: string;
  /** Fallback order when agent is rate-limited */
  fallbackOrder: string[];
  /** Model tier per complexity */
  complexityRouting: Record<Complexity, ModelTier>;
  /** Escalation config */
  escalation: {
    enabled: boolean;
    /** Ordered tier escalation with per-tier attempt budgets */
    tierOrder: Array<{ tier: string; attempts: number; agent?: string }>;
    /** When a batch fails, escalate all stories in the batch (default: true) */
    escalateEntireBatch?: boolean;
  };
}

/** Rectification config (v0.11) */
export interface RectificationConfig {
  /** Enable rectification loop (retry failed tests with failure context) */
  enabled: boolean;
  /** Max retry attempts per story (default: 2) */
  maxRetries: number;
  /** Timeout for full test suite run in seconds (default: 120) */
  fullSuiteTimeoutSeconds: number;
  /** Max characters in failure summary sent to agent (default: 2000) */
  maxFailureSummaryChars: number;
  /** Abort rectification if failure count increases (default: true) */
  abortOnIncreasingFailures: boolean;
  /** Escalate to higher model tier after exhausting maxRetries (default: true) */
  escalateOnExhaustion: boolean;
  /**
   * Attempt number at which "rethink your approach" language is injected into the prompt.
   * Nudges the agent to try a fundamentally different strategy instead of repeating the same fix.
   * Clamped to maxRetries at runtime — so if this exceeds maxRetries it fires on the final attempt. (default: 2)
   */
  rethinkAtAttempt: number;
  /**
   * Attempt number at which "final chance before escalation" urgency is added to the prompt.
   * Should be >= rethinkAtAttempt. Clamped to maxRetries at runtime — so the default of 3 fires
   * on the final attempt when maxRetries=2. (default: 3)
   */
  urgencyAtAttempt: number;
}

/** Regression gate config (BUG-009, BUG-026) */
export interface RegressionGateConfig {
  /** Enable full-suite regression gate after scoped verification (default: true) */
  enabled: boolean;
  /** Timeout for full-suite regression run in seconds (default: 120) */
  timeoutSeconds: number;
  /** Accept timeout as pass instead of failing (BUG-026, default: true) */
  acceptOnTimeout?: boolean;
  /** Mode of regression gate: 'deferred' (run once after all stories), 'per-story' (run after each story), 'disabled' (default: 'deferred') */
  mode?: "deferred" | "per-story" | "disabled";
  /** Max rectification attempts for deferred regression gate (default: 2) */
  maxRectificationAttempts?: number;
}

/** Smart test runner configuration (STR-007) */
export interface SmartTestRunnerConfig {
  /** Enable smart test runner (default: true) */
  enabled: boolean;
  /**
   * Glob patterns to scan for test files during import-grep fallback.
   *
   * Optional — undefined means "user did not set this"; resolver falls through
   * to auto-detection then DEFAULT_TEST_FILE_PATTERNS. Explicit `[]` means
   * "no test files in this scope" (distinct from undefined). (ADR-009)
   */
  testFilePatterns?: string[];
  /** Fallback strategy when path-convention mapping yields no results */
  fallback: "import-grep" | "full-suite";
}

/** Worktree dependency preparation strategy (WT-DEPS-001) */
export interface WorktreeDependenciesConfig {
  /** How nax should prepare a fresh worktree before story execution */
  mode: "inherit" | "provision" | "off";
  /** Explicit provisioning command override (valid only in provision mode) */
  setupCommand?: string | null;
}

/** Execution limits */
export interface ExecutionConfig {
  /** Max iterations per feature run (auto-calculated from tierOrder sum if not set) */
  maxIterations: number;
  /** Delay between iterations (ms) */
  iterationDelayMs: number;
  /** Max cost (USD) before pausing */
  costLimit: number;
  /** Timeout per agent coding session (seconds) */
  sessionTimeoutSeconds: number;
  /** Max retries for non-retryable session errors (e.g. stale/locked session). Default: 1. */
  sessionErrorMaxRetries: number;
  /** Max retries for retryable session errors (e.g. QUEUE_DISCONNECTED_BEFORE_COMPLETION). Default: 3. */
  sessionErrorRetryableMaxRetries: number;
  /** Verification subprocess timeout in seconds (ADR-003 Decision 4) */
  verificationTimeoutSeconds: number;
  /** Max stories per feature (prevents memory exhaustion) */
  maxStoriesPerFeature: number;
  /** Rectification loop settings (v0.11) */
  rectification: RectificationConfig;
  /** Regression gate settings (BUG-009) */
  regressionGate: RegressionGateConfig;
  /** Token budget for plugin context providers (default: 2000) */
  contextProviderTokenBudget: number;
  /** Test command override (null = disabled, undefined = auto-detect from package.json) */
  testCommand?: string | null;
  /** Lint command override (null = disabled, undefined = auto-detect from package.json) */
  lintCommand?: string | null;
  /** Typecheck command override (null = disabled, undefined = auto-detect from package.json) */
  typecheckCommand?: string | null;
  /** Use --dangerously-skip-permissions flag for agent (default: true for backward compat, SEC-1 fix) */
  dangerouslySkipPermissions?: boolean;
  /** Permission profile — takes precedence over dangerouslySkipPermissions (Phase 1) */
  permissionProfile?: "unrestricted" | "safe" | "scoped"; // default: "unrestricted"
  /** Per-stage permission overrides — only read when permissionProfile = "scoped" (Phase 2) */
  permissions?: Record<
    string,
    {
      mode: "approve-all" | "approve-reads" | "scoped";
      allowedTools?: string[];
      inherit?: string;
    }
  >;
  /** Enable smart test runner to scope test runs to changed files (default: true).
   * Accepts boolean for backward compat or a SmartTestRunnerConfig object. */
  smartTestRunner?: boolean | SmartTestRunnerConfig;
  /** Strategy for preparing fresh git worktrees before story execution. */
  worktreeDependencies: WorktreeDependenciesConfig;
  /** Configured agent binary: claude, codex, opencode, gemini, aider (default: claude) */
  agent?: string;
  /** Git HEAD ref captured before agent ran — passed through pipeline for plugin reviewers (FEAT-010) */
  storyGitRef?: string;
  /**
   * Story isolation mode (EXEC-002).
   * "shared": all stories run on the project root branch (current behaviour).
   * "worktree": each story runs in its own git worktree (.nax-wt/<storyId>/).
   *   Passed stories merge into main; failed commits never reach main.
   * Default: "shared"
   */
  storyIsolation: "shared" | "worktree";
}

/** Quality gate config */
export interface QualityConfig {
  /** Require typecheck to pass */
  requireTypecheck: boolean;
  /** Require lint to pass */
  requireLint: boolean;
  /** Require tests to pass */
  requireTests: boolean;
  /** Threshold for scoped test strategy — when changed source files exceed this count, fall back to full suite */
  scopeTestThreshold?: number;
  /** Custom quality commands */
  commands: {
    typecheck?: string;
    lint?: string;
    test?: string;
    /** Scoped test command template with {{files}} placeholder (e.g., "bun test --timeout=60000 {{files}}") */
    testScoped?: string;
    /** Auto-fix lint errors (e.g., "biome check --fix") */
    lintFix?: string;
    /** Auto-fix formatting (e.g., "biome format --write") */
    formatFix?: string;
    /** Build command (e.g., "bun run build") */
    build?: string;
  };
  /** Auto-fix configuration (Phase 2) */
  autofix?: {
    /** Whether to auto-fix lint/format errors before escalating (default: true) */
    enabled?: boolean;
    /** Max auto-fix attempts per review-autofix cycle (default: 2) */
    maxAttempts?: number;
    /** Max total auto-fix attempts across all review-autofix cycles per story (default: 10) */
    maxTotalAttempts?: number;
    /** Inject a rethink prompt on and after this autofix attempt number (default: 2) */
    rethinkAtAttempt?: number;
    /** Inject final-attempt urgency language on and after this autofix attempt number (default: 3) */
    urgencyAtAttempt?: number;
  };
  /** Append --forceExit to test command to prevent open handle hangs (default: false) */
  forceExit: boolean;
  /** Append --detectOpenHandles on timeout retry to diagnose hangs (default: true) */
  detectOpenHandles: boolean;
  /** Max retries with --detectOpenHandles before falling back to --forceExit (default: 1) */
  detectOpenHandlesRetries: number;
  /** Grace period in ms after SIGTERM before sending SIGKILL (default: 5000) */
  gracePeriodMs: number;
  /** Deadline in ms to drain stdout/stderr after killing process (Bun stream workaround, default: 2000) */
  drainTimeoutMs: number;
  /** Shell to use for running verification commands (default: /bin/sh) */
  shell: string;
  /** Environment variables to strip during verification (prevents AI-optimized output) */
  stripEnvVars: string[];
  /** Hermetic test enforcement settings (ENH-010). Supports per-package override. */
  testing?: TestingConfig;
}

/** TDD config */
export interface TddConfig {
  /** Max retries for each session before escalating */
  maxRetries: number;
  /** Auto-verify isolation between sessions */
  autoVerifyIsolation: boolean;
  /** TDD strategy override (default: 'auto') */
  strategy: TddStrategy;
  /** Session 3 verifier: auto-approve legitimate fixes */
  autoApproveVerifier: boolean;
  /** Per-session model tier overrides. Defaults: test-writer=balanced, implementer=story tier, verifier=fast */
  sessionTiers?: {
    /** Model tier for test-writer session (default: "balanced") */
    testWriter?: ModelTier;
    /** Model tier for implementer session (default: uses story's routed tier) */
    implementer?: ModelTier;
    /** Model tier for verifier session (default: "fast") */
    verifier?: ModelTier;
  };
  /** Glob patterns for files test-writer can modify (soft violations, logged as warnings) */
  testWriterAllowedPaths?: string[];
  /** Rollback git changes when TDD fails (default: true). Prevents partial commits when TDD fails. */
  rollbackOnFailure?: boolean;
  /** Enable greenfield detection to force test-after on projects with no test files (default: true, BUG-010) */
  greenfieldDetection?: boolean;
}

// Re-exported from constitution/types.ts to maintain single source of truth
export type { ConstitutionConfig } from "../constitution/types";

// Re-exported from review/types.ts to maintain single source of truth
export type { AdversarialReviewConfig, ReviewConfig } from "../review/types";

/** Plan config */
export interface PlanConfig {
  /** Model selector for planning (tier string or explicit { agent, model }) */
  model: ConfiguredModel;
  /** Output path for generated spec (relative to nax/ directory) */
  outputPath: string;
  /** Timeout for plan sessions in seconds (default: 600) */
  timeoutSeconds?: number;
  /** Override timeout for decompose calls in seconds. Defaults to plan.timeoutSeconds. */
  decomposeTimeoutSeconds?: number;
}

/** Valid test strategy values for acceptance testing */
export type AcceptanceTestStrategy = "unit" | "component" | "cli" | "e2e" | "snapshot";

/** Acceptance fix config (US-001) */
export interface AcceptanceFixConfig {
  /** Model selector for diagnosis (tier string or explicit { agent, model }) */
  diagnoseModel: ConfiguredModel;
  /** Model selector for fix implementation (tier string or explicit { agent, model }) */
  fixModel: ConfiguredModel;
  /** Fix strategy (default: "diagnose-first") */
  strategy: "diagnose-first" | "implement-only";
  /** @deprecated Ignored — outer loop controls retries via acceptance.maxRetries. Kept for backward compat. */
  maxRetries: number;
}

/** Acceptance validation config */
export interface AcceptanceConfig {
  /** Enable acceptance test generation and validation */
  enabled: boolean;
  /** Maximum retry loops for the acceptance fix flow (default: 3) */
  maxRetries: number;
  /** Generate acceptance tests during analyze (default: true) */
  generateTests: boolean;
  /** Path to acceptance test file (relative to feature directory) */
  testPath: string;
  /** Model selector for AC refinement/generation calls (tier string or explicit { agent, model }) */
  model: ConfiguredModel;
  /** Whether to LLM-refine acceptance criteria before generating tests (default: true) */
  refinement: boolean;
  /** Max concurrent refinement LLM calls (default: 3) */
  refinementConcurrency: number;
  /** Whether to run RED gate check after generating acceptance tests (default: true) */
  redGate: boolean;
  /** Override command to run acceptance tests. Use {{FILE}} as placeholder for the test file path.
   *  Default: "bun test {{FILE}} --timeout=60000" */
  command?: string;
  /** Test strategy for acceptance tests (default: auto-detect) */
  testStrategy?: AcceptanceTestStrategy;
  /** Test framework for acceptance tests (default: auto-detect) */
  testFramework?: string;
  /** Timeout for acceptance test generation in milliseconds (default: 1800000 = 30 min) */
  timeoutMs: number;
  /** Fix configuration for acceptance test failures (US-001) */
  fix: AcceptanceFixConfig;
  /** Override filename for suggested acceptance tests (hardening pass) */
  suggestedTestPath?: string;
  /** Hardening pass configuration — test debater-suggested criteria after acceptance passes */
  hardening?: { enabled: boolean };
}

/** Optimizer config (v0.10) */
export interface OptimizerConfig {
  /** Enable prompt optimizer */
  enabled: boolean;
  /** Optimization strategy: "rule-based" | "llm" | "noop" */
  strategy?: "rule-based" | "llm" | "noop";
  /** Strategy-specific configurations */
  strategies?: {
    "rule-based"?: {
      stripWhitespace?: boolean;
      compactCriteria?: boolean;
      deduplicateContext?: boolean;
      maxPromptTokens?: number;
    };
    llm?: {
      model?: ModelTier;
      targetReduction?: number;
      minPromptTokens?: number;
    };
    custom?: {
      module?: string;
      options?: Record<string, unknown>;
    };
  };
}

export interface PluginConfigEntry {
  module: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

/** Raw hooks config as stored in the config file (unvalidated). Use HooksConfig from hooks/types for typed hook definitions. */
export interface RawHooksConfig {
  skipGlobal?: boolean;
  hooks: Record<string, unknown>;
}

/** Interaction config (v0.15.0) */
export interface InteractionConfig {
  /** Plugin to use for interactions (default: "cli") */
  plugin: string;
  /** Plugin-specific configuration */
  config?: Record<string, unknown>;
  /** Default settings */
  defaults: {
    /** Default timeout in milliseconds (default: 600000 = 10 minutes) */
    timeout: number;
    /** Default fallback behavior (default: "escalate") */
    fallback: "continue" | "skip" | "escalate" | "abort";
  };
  /** Enable/disable built-in triggers */
  triggers: Partial<
    Record<string, boolean | { enabled: boolean; fallback?: string; timeout?: number; threshold?: number }>
  >;
}

/** Test coverage context config */
export interface TestCoverageConfig {
  /** Enable test coverage context injection (default: true) */
  enabled: boolean;
  /** Detail level for test summary */
  detail: "names-only" | "names-and-counts" | "describe-blocks";
  /** Max tokens for the summary (default: 500) */
  maxTokens: number;
  /** Test directory relative to workdir (default: auto-detect) */
  testDir?: string;
  /** @deprecated Migrate to execution.smartTestRunner.testFilePatterns. (ADR-009) */
  testPattern?: string;
  /** Scope test coverage to story-relevant files only (default: true) */
  scopeToStory: boolean;
}

export interface ContextAutoDetectConfig {
  enabled: boolean;
  maxFiles: number;
  traceImports: boolean;
}

export interface FeatureContextEngineConfig {
  enabled: boolean;
  budgetTokens: number;
}

/** Pull tool configuration for Context Engine v2 (Phase 4+) */
export interface ContextV2PullConfig {
  /** Enable pull tools — false (default) means assemble() returns empty pullTools array */
  enabled: boolean;
  /** Tool names to activate; empty = all stage-configured tools allowed */
  allowedTools: string[];
  /** Per-session call ceiling */
  maxCallsPerSession: number;
  /** Per-run call ceiling across all sessions */
  maxCallsPerRun: number;
}

/** Availability-fallback configuration (Phase 5.5+) */
export interface ContextV2FallbackConfig {
  /** Enable agent-swap fallback on availability failures */
  enabled: boolean;
  /** Trigger fallback on quality failures too (opt-in) */
  onQualityFailure: boolean;
  /** Maximum agent hops per story before marking failed */
  maxHopsPerStory: number;
  /**
   * Fallback order per agent id.
   * Example: { "claude": ["codex", "gemini"] }
   */
  map: Record<string, string[]>;
}

/** Canonical rules store configuration (Phase 5.1+) */
export interface ContextV2RulesConfig {
  /**
   * Fall back to CLAUDE.md + .claude/rules/ when .nax/rules/ is absent.
   * Default true during migration period; set false to enforce canonical-only.
   */
  allowLegacyClaudeMd: boolean;
  /** Token budget ceiling for canonical rules chunks. */
  budgetTokens: number;
}

/**
 * Registration entry for an external plugin provider (Phase 7+).
 * The engine loads the module and passes config to provider.init() if present.
 */
export interface ContextPluginProviderConfig {
  /** npm package name or workdir-relative path to the provider module */
  module: string;
  /** Provider-specific config, passed to provider.init(config) on load */
  config?: Record<string, unknown>;
  /** Set false to skip loading this provider (default: true) */
  enabled: boolean;
}

/** Context Engine configuration (Phase 0+) */
export interface ContextV2Config {
  /** Enable the Context Engine orchestrator — false by default (opt-in) */
  enabled: boolean;
  /**
   * Min-score threshold for noise filtering.
   * Phase 0 default: 0.1 (near-zero impact).
   */
  minScore: number;
  /** Pull tool configuration (Phase 4+) */
  pull: ContextV2PullConfig;
  /** Canonical rules store configuration (Phase 5.1+) */
  rules: ContextV2RulesConfig;
  /** Availability-fallback configuration (Phase 5.5+) */
  fallback: ContextV2FallbackConfig;
  /** External plugin providers to load (Phase 7+). Empty by default. */
  pluginProviders: ContextPluginProviderConfig[];
  /**
   * Per-stage token budget overrides (AC-59).
   * Set via per-package config (<repoRoot>/.nax/mono/<packageDir>/config.json).
   * Keys are stage names; value overrides the default stage budgetTokens.
   */
  stages: Record<string, { budgetTokens?: number }>;
  /**
   * Determinism mode (AC-24).
   * When true, providers declaring `deterministic: false` are excluded from assembly.
   */
  deterministic: boolean;
  /** Session scratch retention settings (AC-20) */
  session: {
    /** Days to retain completed session scratch dirs before purging. */
    retentionDays: number;
    /** When true and the feature run fully completes, archive to _archive/ instead of deleting. */
    archiveOnFeatureArchive: boolean;
  };
  /** Staleness detection for feature context entries (Amendment A AC-46/AC-47) */
  staleness: {
    /** Enable staleness detection. Default: true. */
    enabled: boolean;
    /** Stories after which a context entry is age-stale. Default: 10. */
    maxStoryAge: number;
    /** Score multiplier applied to stale chunks (0–1). Default: 0.4. */
    scoreMultiplier: number;
  };
  /** Built-in provider scope configuration (#507). */
  providers: {
    /** Working directory scope for GitHistoryProvider. Default: "package". */
    historyScope: "repo" | "package";
    /** Working directory scope for CodeNeighborProvider. Default: "package". */
    neighborScope: "repo" | "package";
    /** Cross-package scan depth for CodeNeighborProvider. Default: 1. */
    crossPackageDepth: number;
  };
}

export interface ContextConfig {
  testCoverage: TestCoverageConfig;
  autoDetect: ContextAutoDetectConfig;
  fileInjection?: "keyword" | "disabled";
  featureEngine?: FeatureContextEngineConfig; // Context Engine v1
  /** Context Engine settings (Phase 6: enabled by default) */
  v2: ContextV2Config;
}

/** Story size gate thresholds (v0.16.0) */
export interface StorySizeGateConfig {
  /** Enable story size gate (default: true) */
  enabled: boolean;
  /** Max acceptance criteria count before flagging (default: 10) */
  maxAcCount: number;
  /** Max description character length before flagging (default: 3000) */
  maxDescriptionLength: number;
  /** Max bullet point count before flagging (default: 12) */
  maxBulletPoints: number;
  /** Action when stories exceed thresholds: 'block' (fail-fast), 'warn' (non-blocking), 'skip' (disabled) */
  action: "block" | "warn" | "skip";
  /** Max number of replan attempts before escalating (default: 3) */
  maxReplanAttempts: number;
}

/** Precheck configuration (v0.16.0) */
export interface PrecheckConfig {
  /** Story size gate settings */
  storySizeGate: StorySizeGateConfig;
}

export interface AdaptiveRoutingConfig {
  minSamples: number;
  costThreshold: number;
  fallbackStrategy: "keyword" | "llm" | "manual";
}

/** LLM routing config */
export interface LlmRoutingConfig {
  /** Model selector for routing call (tier string or explicit { agent, model }) */
  model?: ConfiguredModel;
  /** Fall back to keyword strategy on LLM failure (default: true) */
  fallbackToKeywords?: boolean;
  /** Max input tokens for story context (default: 2000) */
  /** Cache routing decisions per story ID (default: true) */
  cacheDecisions?: boolean;
  /** Routing mode (default: "hybrid")
   * - "one-shot": batch-route ALL pending stories once at run start, use keyword fallback on cache miss
   * - "per-story": route each story individually just before execution (max LLM calls = N stories)
   * - "hybrid": batch-route upfront, re-route individually on retry/failure (best quality + cost balance)
   */
  mode?: LlmRoutingMode;
  /** @deprecated Use mode instead. Will be removed in v1.0 */
  batchMode?: boolean;
  /** Timeout for LLM call in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Number of retries on LLM timeout or transient failure (default: 1) */
  retries?: number;
  /** Delay between retries in milliseconds (default: 1000) */
  retryDelayMs?: number;
}

/** Routing config */
export interface RoutingConfig {
  /** Strategy to use (default: "keyword") */
  strategy: RoutingStrategyName;
  /** Path to custom strategy file (required if strategy = "custom") */
  customStrategyPath?: string;
  /** Adaptive routing settings (used when strategy = "adaptive") */
  adaptive?: AdaptiveRoutingConfig;
  /** LLM routing settings (used when strategy = "llm") */
  llm?: LlmRoutingConfig;
}

/** Prompt overrides config (PB-003) */
export interface PromptsConfig {
  overrides?: Partial<
    Record<"no-test" | "test-writer" | "implementer" | "verifier" | "single-session" | "tdd-simple" | "batch", string>
  >;
}

/** Hermetic test enforcement configuration (ENH-010) */
export interface TestingConfig {
  /**
   * When true (default), nax injects a hermetic test requirement into all code-writing prompts.
   * Instructs the AI to mock all I/O boundaries and never call real external services in tests.
   */
  hermetic: boolean;
  /**
   * Project-specific external boundaries to mock (e.g. ["claude", "acpx", "redis", "grpc"]).
   * Injected into the hermetic requirement section so the AI knows which project tools to mock.
   */
  externalBoundaries?: string[];
  /**
   * Project-specific mocking guidance injected verbatim into the prompt.
   * E.g. "Use injectable deps for CLI spawning, ioredis-mock for Redis"
   */
  mockGuidance?: string;
}

/** Project profile — language and tooling metadata for language-aware features (US-001) */
export interface ProjectProfile {
  language?: "typescript" | "javascript" | "go" | "rust" | "python" | "ruby" | "java" | "kotlin" | "php";
  type?: string;
  testFramework?: string;
  lintTool?: string;
}

// Re-exported from debate/types.ts to maintain single source of truth
export type {
  DebateConfig,
  DebateStageConfig,
  ResolverConfig,
  Debater,
  DebateResult,
  ResolverType,
  SessionMode,
} from "../debate/types";

/** Full nax configuration */
export interface NaxConfig {
  /** Schema version */
  version: 1;
  /** Model mapping — per-agent tier map: Record<agentName, Record<tierName, ModelEntry>> */
  models: ModelsConfig;
  /** Auto mode / routing config */
  autoMode: AutoModeConfig;
  /** Routing strategy config */
  routing: RoutingConfig;
  /** Execution limits */
  execution: ExecutionConfig;
  /** Quality gates */
  quality: QualityConfig;
  /** TDD settings */
  tdd: TddConfig;
  /** Constitution settings */
  constitution: ConstitutionConfig;
  /** Review settings */
  review: ReviewConfig;
  /** Plan settings */
  plan: PlanConfig;
  /** Acceptance validation settings */
  acceptance: AcceptanceConfig;
  /** Context injection settings */
  context: ContextConfig;
  /** Optimizer settings (v0.10) */
  optimizer?: OptimizerConfig;
  /** Plugin configurations (v0.10) */
  plugins?: PluginConfigEntry[];
  /** Disabled plugin names (v0.38.2) */
  disabledPlugins?: string[];
  /** Hooks configuration (v0.10) */
  hooks?: RawHooksConfig;
  /** Interaction settings (v0.15.0) */
  interaction?: InteractionConfig;
  /** Precheck settings (v0.16.0) */
  precheck?: PrecheckConfig;
  /** Prompt override settings (PB-003) */
  prompts?: PromptsConfig;
  /** Agent protocol settings (ACP-003) */
  agent?: AgentConfig;
  /** Generate settings */
  generate?: GenerateConfig;
  /** Project profile — language and tooling metadata (US-001) */
  project?: ProjectProfile;
  /** Multi-agent debate settings */
  debate?: import("../debate/types").DebateConfig;
  /** Configuration profile name (default: "default") */
  profile: string;
}

/** Generate command configuration */
export interface GenerateConfig {
  /**
   * Agents to generate config files for (default: all).
   * Restricts `nax generate` to only the listed agents.
   * @example ["claude", "opencode"]
   */
  agents?: Array<"claude" | "codex" | "opencode" | "cursor" | "windsurf" | "aider" | "gemini">;
}

/** Prompt audit configuration — opt-in file-based audit of all ACP-bound prompts. */
export interface PromptAuditConfig {
  /** When true, every prompt sent to ACP is written to a file for auditing. */
  enabled: boolean;
  /**
   * Directory to write audit files into.
   * Absolute path, or relative to workdir. Defaults to <workdir>/.nax/prompt-audit/ when absent.
   */
  dir?: string;
}

/** Agent fallback configuration */
export interface AgentFallbackConfig {
  /** Whether agent fallback is enabled (default: false) */
  enabled?: boolean;
  /** Fallback map: agent name → ordered list of fallback agent names */
  map?: Record<string, string[]>;
  /** Maximum fallback hops per story (default: 2, min 1, max 10) */
  maxHopsPerStory?: number;
  /** Whether to fall back on quality failure (default: false) */
  onQualityFailure?: boolean;
  /** Whether to rebuild context on fallback (default: true) */
  rebuildContext?: boolean;
}

/** Agent protocol configuration (ACP-003) */
export interface AgentConfig {
  /** Protocol to use for agent communication (always 'acp') */
  protocol?: "acp";
  /** Default agent name to use (default: 'claude') */
  default?: string;
  /** Max interaction turns when interactionBridge is active (default: 20) */
  maxInteractionTurns?: number;
  /** Prompt audit — write every ACP-bound prompt to a file for auditing. */
  promptAudit?: PromptAuditConfig;
  /** Agent fallback configuration */
  fallback?: AgentFallbackConfig;
}
