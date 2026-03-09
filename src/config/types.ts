/**
 * Configuration Type Definitions
 *
 * All TypeScript interfaces, type aliases, and utility functions
 * for the nax configuration system.
 */

export type Complexity = "simple" | "medium" | "complex" | "expert";
export type TestStrategy = "test-after" | "tdd-simple" | "three-session-tdd" | "three-session-tdd-lite";
export type TddStrategy = "auto" | "strict" | "lite" | "simple" | "off";

export interface EscalationEntry {
  from: string;
  to: string;
}

/** Model tier names — extensible (TYPE-3 fix: preserve autocomplete for known tiers) */
export type ModelTier = "fast" | "balanced" | "powerful" | (string & {});

export interface TokenPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export interface ModelDef {
  provider: string;
  model: string;
  pricing?: TokenPricing;
  env?: Record<string, string>;
}

export type ModelEntry = ModelDef | string;
export type ModelMap = Record<ModelTier, ModelEntry>;

export interface TierConfig {
  tier: string;
  attempts: number;
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
    tierOrder: TierConfig[];
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
  /** Glob patterns to scan for test files during import-grep fallback */
  testFilePatterns: string[];
  /** Fallback strategy when path-convention mapping yields no results */
  fallback: "import-grep" | "full-suite";
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
  /** Enable smart test runner to scope test runs to changed files (default: true).
   * Accepts boolean for backward compat or a SmartTestRunnerConfig object. */
  smartTestRunner?: boolean | SmartTestRunnerConfig;
  /** Configured agent binary: claude, codex, opencode, gemini, aider (default: claude) */
  agent?: string;
}

/** Quality gate config */
export interface QualityConfig {
  /** Require typecheck to pass */
  requireTypecheck: boolean;
  /** Require lint to pass */
  requireLint: boolean;
  /** Require tests to pass */
  requireTests: boolean;
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
  };
  /** Auto-fix configuration (Phase 2) */
  autofix?: {
    /** Whether to auto-fix lint/format errors before escalating (default: true) */
    enabled?: boolean;
    /** Max auto-fix attempts (default: 2) */
    maxAttempts?: number;
  };
  /** Append --forceExit to test command to prevent open handle hangs (default: false) */
  forceExit: boolean;
  /** Append --detectOpenHandles on timeout retry to diagnose hangs (default: true) */
  detectOpenHandles: boolean;
  /** Max retries with --detectOpenHandles before falling back to --forceExit (default: 1) */
  detectOpenHandlesRetries: number;
  /** Grace period in ms after SIGTERM before sending SIGKILL (default: 5000) */
  gracePeriodMs: number;
  /** Use --dangerously-skip-permissions for agent sessions (default: false) */
  dangerouslySkipPermissions: boolean;
  /** Deadline in ms to drain stdout/stderr after killing process (Bun stream workaround, default: 2000) */
  drainTimeoutMs: number;
  /** Shell to use for running verification commands (default: /bin/sh) */
  shell: string;
  /** Environment variables to strip during verification (prevents AI-optimized output) */
  stripEnvVars: string[];
  /** Divisor for environmental failure early escalation (default: 2 = half the tier budget) */
  environmentalEscalationDivisor: number;
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

/** Constitution config */
export interface ConstitutionConfig {
  /** Enable constitution loading and injection */
  enabled: boolean;
  /** Path to constitution file relative to nax/ directory */
  path: string;
  /** Maximum tokens allowed for constitution content */
  maxTokens: number;
  /** Skip loading global constitution (default: false) */
  skipGlobal?: boolean;
}

/** Analyze config */
export interface AnalyzeConfig {
  /** Enable LLM-enhanced analysis */
  llmEnhanced: boolean;
  /** Model tier for decompose+classify (default: balanced) */
  model: ModelTier;
  /** Fall back to keyword matching on LLM failure */
  fallbackToKeywords: boolean;
  /** Max tokens for codebase summary */
  maxCodebaseSummaryTokens: number;
}

/** Review config */
export interface ReviewConfig {
  /** Enable review phase */
  enabled: boolean;
  /** List of checks to run */
  checks: Array<"typecheck" | "lint" | "test">;
  /** Custom commands per check */
  commands: {
    typecheck?: string;
    lint?: string;
    test?: string;
  };
}

/** Plan config */
export interface PlanConfig {
  /** Model tier for planning (default: balanced) */
  model: ModelTier;
  /** Output path for generated spec (relative to nax/ directory) */
  outputPath: string;
}

/** Acceptance validation config */
export interface AcceptanceConfig {
  /** Enable acceptance test generation and validation */
  enabled: boolean;
  /** Maximum retry loops for fix stories (default: 2) */
  maxRetries: number;
  /** Generate acceptance tests during analyze (default: true) */
  generateTests: boolean;
  /** Path to acceptance test file (relative to feature directory) */
  testPath: string;
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
}

export interface HooksConfig {
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
  /** Glob pattern for test files */
  testPattern: string;
  /** Scope test coverage to story-relevant files only (default: true) */
  scopeToStory: boolean;
}

export interface ContextAutoDetectConfig {
  enabled: boolean;
  maxFiles: number;
  traceImports: boolean;
}

export interface ContextConfig {
  testCoverage: TestCoverageConfig;
  autoDetect: ContextAutoDetectConfig;
  fileInjection?: "keyword" | "disabled";
}

/** Story size gate thresholds (v0.16.0) */
export interface StorySizeGateConfig {
  /** Enable story size gate (default: true) */
  enabled: boolean;
  /** Max acceptance criteria count before flagging (default: 6) */
  maxAcCount: number;
  /** Max description character length before flagging (default: 2000) */
  maxDescriptionLength: number;
  /** Max bullet point count before flagging (default: 8) */
  maxBulletPoints: number;
}

/** Precheck configuration (v0.16.0) */
export interface PrecheckConfig {
  /** Story size gate settings */
  storySizeGate: StorySizeGateConfig;
}

export type RoutingStrategyName = "keyword" | "llm" | "manual" | "adaptive" | "custom";

export interface AdaptiveRoutingConfig {
  minSamples: number;
  costThreshold: number;
  fallbackStrategy: "keyword" | "llm" | "manual";
}

export type LlmRoutingMode = "one-shot" | "per-story" | "hybrid";

/** LLM routing config */
export interface LlmRoutingConfig {
  /** Model tier for routing call (default: "fast") */
  model?: string;
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
  overrides?: Partial<Record<"test-writer" | "implementer" | "verifier" | "single-session" | "tdd-simple", string>>;
}

/** Decompose config (SD-003) */
export interface DecomposeConfig {
  /** Trigger mode: 'auto' = decompose automatically, 'confirm' = ask user, 'disabled' = skip */
  trigger: "auto" | "confirm" | "disabled";
  /** Max acceptance criteria before flagging a story as oversized (default: 6) */
  maxAcceptanceCriteria: number;
  /** Max number of substories to generate (default: 5) */
  maxSubstories: number;
  /** Max complexity for any generated substory (default: 'medium') */
  maxSubstoryComplexity: Complexity;
  /** Max retries on decomposition validation failure (default: 2) */
  maxRetries: number;
  /** Model tier for decomposition LLM calls (default: 'balanced') */
  model: ModelTier;
}

/** Full nax configuration */
export interface NaxConfig {
  /** Schema version */
  version: 1;
  /** Model mapping — abstract tiers to actual model identifiers */
  models: ModelMap;
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
  /** Analyze settings */
  analyze: AnalyzeConfig;
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
  /** Hooks configuration (v0.10) */
  hooks?: HooksConfig;
  /** Interaction settings (v0.15.0) */
  interaction?: InteractionConfig;
  /** Precheck settings (v0.16.0) */
  precheck?: PrecheckConfig;
  /** Prompt override settings (PB-003) */
  prompts?: PromptsConfig;
  /** Decompose settings (SD-003) */
  decompose?: DecomposeConfig;
}

/** Resolve a ModelEntry (string shorthand or full object) into a ModelDef */
export function resolveModel(entry: ModelEntry): ModelDef {
  if (typeof entry === "string") {
    // Infer provider from model name
    const provider = entry.startsWith("claude")
      ? "anthropic"
      : entry.startsWith("gpt") || entry.startsWith("o1") || entry.startsWith("o3")
        ? "openai"
        : entry.startsWith("gemini")
          ? "google"
          : "unknown";
    return { provider, model: entry };
  }
  return entry;
}
