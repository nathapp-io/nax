/**
 * Zod Schema Definitions
 *
 * Runtime validation schemas for nax configuration.
 */

import { z } from "zod";

/** Zod schema for runtime validation */
const TokenPricingSchema = z.object({
  inputPer1M: z.number().min(0),
  outputPer1M: z.number().min(0),
});

const ModelDefSchema = z.object({
  provider: z.string().min(1, "Provider must be non-empty"),
  model: z.string().min(1, "Model must be non-empty"),
  pricing: TokenPricingSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const ModelEntrySchema = z.union([z.string().min(1, "Model identifier must be non-empty"), ModelDefSchema]);

/** Detect legacy flat format: any top-level value is a string or has 'provider'/'model' key directly */
function isLegacyFlatModels(val: unknown): boolean {
  if (typeof val !== "object" || val === null) return false;
  const obj = val as Record<string, unknown>;
  for (const v of Object.values(obj)) {
    if (typeof v === "string") return true;
    if (typeof v === "object" && v !== null && ("provider" in v || "model" in v)) return true;
  }
  return false;
}

/** Per-agent model map: Record<agentName, Record<tierName, ModelEntry>> */
const PerAgentModelMapSchema = z.record(z.string().min(1), z.record(z.string().min(1), ModelEntrySchema));

const ModelMapSchema = z.preprocess((val) => {
  if (isLegacyFlatModels(val)) {
    return { claude: val };
  }
  return val;
}, PerAgentModelMapSchema);

const ModelTierSchema = z.string().min(1, "Tier name must be non-empty");
const ConfiguredModelObjectSchema = z.object({
  agent: z.string().min(1, "agent must be non-empty"),
  model: z.string().min(1, "model must be non-empty"),
});
const ConfiguredModelSchema = z.union([ModelTierSchema, ConfiguredModelObjectSchema]);

const TierConfigSchema = z.object({
  tier: z.string().min(1, "Tier name must be non-empty"),
  attempts: z.number().int().min(1).max(20, { message: "attempts must be 1-20" }),
});

const AutoModeConfigSchema = z.object({
  enabled: z.boolean(),
  defaultAgent: z.string().trim().min(1, "defaultAgent must be non-empty"),
  fallbackOrder: z.array(z.string()),
  complexityRouting: z.object({
    simple: ModelTierSchema,
    medium: ModelTierSchema,
    complex: ModelTierSchema,
    expert: ModelTierSchema,
  }),
  escalation: z.object({
    enabled: z.boolean(),
    tierOrder: z.array(TierConfigSchema).min(1, { message: "tierOrder must have at least one tier" }),
    escalateEntireBatch: z.boolean().optional(),
  }),
});

const RectificationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxRetries: z.number().int().min(0).max(10).default(2),
  fullSuiteTimeoutSeconds: z.number().int().min(10).max(600).default(120),
  maxFailureSummaryChars: z.number().int().min(500).max(10000).default(2000),
  abortOnIncreasingFailures: z.boolean().default(true),
  escalateOnExhaustion: z.boolean().optional().default(true),
  rethinkAtAttempt: z.number().int().min(1).default(2),
  urgencyAtAttempt: z.number().int().min(1).default(3),
});

const RegressionGateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(10).max(600).default(120),
  acceptOnTimeout: z.boolean().default(true),
  mode: z.enum(["deferred", "per-story", "disabled"]).default("deferred"),
  maxRectificationAttempts: z.number().int().min(1).default(2),
});

const SmartTestRunnerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Optional — undefined means user did not set this; resolver falls through
   * to auto-detection then DEFAULT_TEST_FILE_PATTERNS. (ADR-009)
   */
  testFilePatterns: z.array(z.string()).optional(),
  fallback: z.enum(["import-grep", "full-suite"]).default("import-grep"),
});

const SMART_TEST_RUNNER_DEFAULT = {
  enabled: true,
  fallback: "import-grep" as const,
};

/** Coerces boolean → SmartTestRunnerConfig for backward compat */
const smartTestRunnerFieldSchema = z
  .preprocess((val) => {
    if (typeof val === "boolean") {
      return { enabled: val, fallback: "import-grep" };
    }
    return val;
  }, SmartTestRunnerConfigSchema)
  .default(SMART_TEST_RUNNER_DEFAULT);

const ExecutionConfigSchema = z.object({
  maxIterations: z.number().int().positive({ message: "maxIterations must be > 0" }),
  iterationDelayMs: z.number().int().nonnegative(),
  costLimit: z.number().positive({ message: "costLimit must be > 0" }),
  sessionTimeoutSeconds: z.number().int().positive({ message: "sessionTimeoutSeconds must be > 0" }).default(3600),
  /** Max retries when acpx signals a non-retryable session error (e.g. stale/locked session). */
  sessionErrorMaxRetries: z.number().int().min(0).max(5).default(1),
  /** Max retries when acpx signals a retryable session error (e.g. QUEUE_DISCONNECTED_BEFORE_COMPLETION). */
  sessionErrorRetryableMaxRetries: z.number().int().min(0).max(10).default(3),
  verificationTimeoutSeconds: z.number().int().min(1).max(3600).default(300),
  maxStoriesPerFeature: z.number().int().positive(),
  rectification: RectificationConfigSchema,
  regressionGate: RegressionGateConfigSchema,
  contextProviderTokenBudget: z
    .number()
    .int()
    .positive({ message: "contextProviderTokenBudget must be > 0" })
    .default(2000),
  lintCommand: z.string().nullable().optional(),
  typecheckCommand: z.string().nullable().optional(),
  // DEPRECATED — use permissionProfile instead. Kept for backward compat.
  dangerouslySkipPermissions: z.boolean().default(true),
  // NEW — takes precedence over dangerouslySkipPermissions
  permissionProfile: z.enum(["unrestricted", "safe", "scoped"]).default("unrestricted"),
  // Phase 2: per-stage permission overrides (only read when profile = "scoped")
  permissions: z
    .record(
      z.string(),
      z.object({
        mode: z.enum(["approve-all", "approve-reads", "scoped"]),
        allowedTools: z.array(z.string()).optional(),
        inherit: z.string().optional(),
      }),
    )
    .optional(),
  smartTestRunner: smartTestRunnerFieldSchema,
  storyIsolation: z.enum(["shared", "worktree"]).default("shared"),
});

const QualityConfigSchema = z.object({
  requireTypecheck: z.boolean().default(true),
  requireLint: z.boolean().default(true),
  requireTests: z.boolean().default(true),
  scopeTestThreshold: z.number().int().min(0).default(10),
  commands: z
    .object({
      typecheck: z.string().optional(),
      lint: z.string().optional(),
      test: z.string().optional(),
      testScoped: z.string().optional(),
      lintFix: z.string().optional(),
      formatFix: z.string().optional(),
      build: z.string().optional(),
    })
    .default({}),
  autofix: z
    .object({
      enabled: z.boolean().default(true),
      maxAttempts: z.number().int().min(1).default(3),
      maxTotalAttempts: z.number().int().min(1).default(12),
      rethinkAtAttempt: z.number().int().min(1).default(2),
      urgencyAtAttempt: z.number().int().min(1).default(3),
    })
    .default({
      enabled: true,
      maxAttempts: 3,
      maxTotalAttempts: 12,
      rethinkAtAttempt: 2,
      urgencyAtAttempt: 3,
    }),
  forceExit: z.boolean().default(false),
  detectOpenHandles: z.boolean().default(true),
  detectOpenHandlesRetries: z.number().int().min(0).max(5).default(1),
  gracePeriodMs: z.number().int().min(500).max(30000).default(5000),
  drainTimeoutMs: z.number().int().min(0).max(10000).default(2000),
  shell: z.string().default("/bin/sh"),
  stripEnvVars: z
    .array(z.string())
    .default([
      "CLAUDECODE",
      "REPL_ID",
      "AGENT",
      "GITLAB_ACCESS_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_ACCESS_TOKEN",
      "GH_TOKEN",
      "CI_GIT_TOKEN",
      "CI_JOB_TOKEN",
      "BITBUCKET_ACCESS_TOKEN",
      "NPM_TOKEN",
      "NPM_AUTH_TOKEN",
      "YARN_NPM_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "COHERE_API_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GCLOUD_SERVICE_KEY",
      "AZURE_CLIENT_SECRET",
      "AZURE_TENANT_ID",
      "TELEGRAM_BOT_TOKEN",
      "SLACK_TOKEN",
      "SLACK_WEBHOOK_URL",
      "SENTRY_AUTH_TOKEN",
      "DATADOG_API_KEY",
    ]),

  testing: z
    .object({
      /**
       * When true (default), nax injects a hermetic test requirement into all code-writing prompts.
       * Instructs the AI to mock all I/O boundaries (HTTP, CLI spawning, databases, etc.)
       * and never invoke real external processes or services during test execution.
       * Set to false only if your project requires real integration calls in tests.
       */
      hermetic: z.boolean().default(true),
      /**
       * Project-specific external boundaries the AI should watch for and mock.
       * E.g. ["claude", "acpx", "redis", "grpc"] — any CLI tools, clients, or services
       * the project uses that should never be called from tests.
       */
      externalBoundaries: z.array(z.string()).optional(),
      /**
       * Project-specific guidance on how to mock external dependencies.
       * Injected verbatim into the hermetic requirement section of the prompt.
       * E.g. "Use injectable deps for CLI spawning, ioredis-mock for Redis"
       */
      mockGuidance: z.string().optional(),
    })
    .optional(),
});

const TddConfigSchema = z.object({
  maxRetries: z.number().int().nonnegative(),
  autoVerifyIsolation: z.boolean(),
  autoApproveVerifier: z.boolean(),
  strategy: z.enum(["auto", "strict", "lite", "off"]).default("auto"),
  sessionTiers: z
    .object({
      testWriter: z.string().optional(),
      implementer: z.string().optional(),
      verifier: z.string().optional(),
    })
    .optional(),
  testWriterAllowedPaths: z.array(z.string()).optional(),
  rollbackOnFailure: z.boolean().optional(),
  greenfieldDetection: z.boolean().optional(),
});

const ConstitutionConfigSchema = z.object({
  enabled: z.boolean(),
  path: z.string().min(1, "constitution.path must be non-empty"),
  maxTokens: z.number().int().positive({ message: "constitution.maxTokens must be > 0" }),
  skipGlobal: z.boolean().optional(),
});

const SemanticReviewConfigSchema = z.object({
  modelTier: ModelTierSchema.default("balanced"),
  /**
   * How the semantic reviewer accesses the git diff.
   * "embedded" (default): pre-collected diff truncated at 50KB and embedded in prompt.
   * "ref": only stat summary + storyGitRef passed; reviewer fetches full diff via tools.
   */
  diffMode: z.enum(["embedded", "ref"]).default("embedded"),
  /**
   * When true, clears storyGitRef on failed stories during re-run initialization so
   * the ref is re-captured at the next story start. Prevents cross-story diff pollution
   * when multiple stories exhaust all tiers and are re-run. Default false (current behaviour).
   */
  resetRefOnRerun: z.boolean().default(false),
  rules: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().default(600_000),
  /**
   * Optional — undefined means "derive from testFilePatterns + well-known noise dirs".
   * Any user-set value (including []) is returned as-is. (ADR-009 §4.4)
   */
  excludePatterns: z.array(z.string()).optional(),
});

export const ReviewDialogueConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxClarificationsPerAttempt: z.number().int().min(0).max(10).default(2),
  maxDialogueMessages: z.number().int().min(5).max(100).default(20),
});

/**
 * Adversarial review config — ships off by default (opt-in via review.checks).
 * Destructive heuristics: finds what is missing or broken, not what is present.
 */
export const AdversarialReviewConfigSchema = z.object({
  modelTier: ModelTierSchema.default("balanced"),
  /**
   * "ref" (default): reviewer self-serves the full diff via git tools — no 50KB cap,
   *   test files included. Instructs reviewer to run git diff commands.
   * "embedded": pre-collected full diff (no excludePatterns) embedded in prompt.
   */
  diffMode: z.enum(["embedded", "ref"]).default("ref"),
  /** Custom adversarial heuristic rules to append to the prompt. */
  rules: z.array(z.string()).default([]),
  /** LLM call timeout in milliseconds. Default 600s (matches semantic — no debate path but ref mode may need full tool traversal). */
  timeoutMs: z.number().int().positive().default(600_000),
  /**
   * Pathspec exclusions applied in embedded mode (to collectDiff) and in ref mode
   * (shown in the prompt's git commands).
   *
   * Optional — undefined means "derive from testFilePatterns + noise dirs" (adversarial
   * defaults to minimal exclusions so it sees test files). Any user-set value (including [])
   * is returned as-is. (ADR-009 §4.4)
   */
  excludePatterns: z.array(z.string()).optional(),
  /**
   * When true, run semantic and adversarial reviewers concurrently via Promise.all.
   * Default false (conservative rollout). Only activates when session count is within cap.
   */
  parallel: z.boolean().default(false),
  /** Maximum combined reviewer sessions before falling back to sequential. Default 2. */
  maxConcurrentSessions: z.number().int().min(1).max(4).default(2),
});

const ReviewConfigSchema = z.object({
  enabled: z.boolean(),
  checks: z.array(z.enum(["typecheck", "lint", "test", "build", "semantic", "adversarial"])),
  commands: z.object({
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    test: z.string().optional(),
    build: z.string().optional(),
    lintFix: z.string().optional(),
    formatFix: z.string().optional(),
  }),
  pluginMode: z.enum(["per-story", "deferred"]).default("per-story"),
  audit: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
  /**
   * Minimum severity that counts as a blocking finding.
   * "error"   (default): only error/critical findings block; warnings are advisory.
   * "warning": error, critical, AND warning findings block; info is advisory.
   * "info":    all findings block (strictest mode).
   *
   * Hierarchy: info < warning < error < critical.
   * Applies only to LLM-based checkers (semantic, adversarial).
   * Mechanical checks (lint, typecheck, test, build) always block on failure.
   */
  blockingThreshold: z.enum(["error", "warning", "info"]).default("error"),
  semantic: SemanticReviewConfigSchema.optional(),
  adversarial: AdversarialReviewConfigSchema.optional(),
  dialogue: ReviewDialogueConfigSchema.default({
    enabled: false,
    maxClarificationsPerAttempt: 2,
    maxDialogueMessages: 20,
  }),
});

const PlanConfigSchema = z.object({
  model: ConfiguredModelSchema,
  outputPath: z.string().min(1, "plan.outputPath must be non-empty"),
  timeoutSeconds: z.number().int().positive().default(600),
  /** Override timeout for decompose calls in seconds. Defaults to plan.timeoutSeconds. */
  decomposeTimeoutSeconds: z.number().int().min(30).max(1_800).optional(),
});

const AcceptanceFixConfigSchema = z.object({
  diagnoseModel: ConfiguredModelSchema.default("fast"),
  fixModel: ConfiguredModelSchema.default("balanced"),
  strategy: z.enum(["diagnose-first", "implement-only"]).default("diagnose-first"),
  maxRetries: z.number().int().nonnegative().default(2),
});

export const AcceptanceConfigSchema = z.object({
  enabled: z.boolean(),
  maxRetries: z.number().int().nonnegative(),
  generateTests: z.boolean(),
  testPath: z.string().min(1, "acceptance.testPath must be non-empty"),
  command: z.string().optional(),
  model: ConfiguredModelSchema.default("fast"),
  refinement: z.boolean().default(true),
  refinementConcurrency: z.number().int().min(1).max(10).default(3),
  redGate: z.boolean().default(true),
  testStrategy: z.enum(["unit", "component", "cli", "e2e", "snapshot"]).optional(),
  testFramework: z.string().min(1, "acceptance.testFramework must be non-empty").optional(),
  timeoutMs: z.number().int().min(30000).max(3600000).default(1800000),
  fix: AcceptanceFixConfigSchema.optional().default({
    diagnoseModel: "fast",
    fixModel: "balanced",
    strategy: "diagnose-first",
    maxRetries: 2,
  }),
  suggestedTestPath: z.string().min(1).optional(),
  hardening: z
    .object({
      enabled: z.boolean().default(true),
    })
    .optional()
    .default({ enabled: true }),
});

const TestCoverageConfigSchema = z.object({
  enabled: z.boolean().default(true),
  detail: z.enum(["names-only", "names-and-counts", "describe-blocks"]).default("names-and-counts"),
  maxTokens: z.number().int().min(50).max(5000).default(500),
  testDir: z.string().optional(),
  /** @deprecated Migrate to execution.smartTestRunner.testFilePatterns. Migration shim in src/config/migrations.ts. */
  testPattern: z.string().optional(),
  scopeToStory: z.boolean().default(true),
});

const ContextAutoDetectConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxFiles: z.number().int().min(1).max(20).default(5),
  traceImports: z.boolean().default(false),
});

const FeatureContextEngineConfigSchema = z.object({
  enabled: z.boolean().default(false),
  budgetTokens: z.number().int().min(256).default(2048),
});

// Context Engine v2 pull tool config (Phase 4)
const ContextV2PullConfigSchema = z
  .object({
    /**
     * Enable pull tools for this run.
     * When false (default), assemble() returns an empty pullTools array.
     */
    enabled: z.boolean().default(false),
    /**
     * Tool names permitted to activate. Empty array = all stage-configured tools allowed.
     * Use to restrict which tools are enabled without changing the stage map.
     */
    allowedTools: z.array(z.string()).default([]),
    /**
     * Per-session call ceiling (overrides the descriptor default when set).
     */
    maxCallsPerSession: z.number().int().min(0).default(5),
    /**
     * Per-run call ceiling across all sessions in a single nax run.
     */
    maxCallsPerRun: z.number().int().min(0).default(50),
  })
  .default(() => ({ enabled: false, allowedTools: [], maxCallsPerSession: 5, maxCallsPerRun: 50 }));

// Context Engine v2 availability-fallback config (Phase 5.5)
const ContextV2FallbackConfigSchema = z
  .object({
    /**
     * Enable agent-swap fallback on availability failures (rate-limit, quota, auth, service-down).
     * Default false — operators must opt in by populating the fallback map.
     */
    enabled: z.boolean().default(false),
    /**
     * Also trigger agent fallback on quality failures (review/verify reject).
     * Default false — quality failures route to tier escalation by default.
     */
    onQualityFailure: z.boolean().default(false),
    /**
     * Maximum number of agent hops per story.
     * Once exhausted the story is marked failed with "all-agents-unavailable".
     */
    maxHopsPerStory: z.number().int().min(1).max(10).default(2),
    /**
     * Fallback order per agent id.
     * Example: { "claude": ["codex", "gemini"], "codex": ["claude"] }
     * Empty map → fallback is never attempted even when enabled.
     */
    map: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
  })
  .default(() => ({ enabled: false, onQualityFailure: false, maxHopsPerStory: 2, map: {} }));

// Context Engine v2 rules config (Phase 5.1)
const ContextV2RulesConfigSchema = z
  .object({
    /**
     * Fall back to reading CLAUDE.md + .claude/rules/ when .nax/rules/ is absent.
     * Default true for one version (migration period); set false once canonical
     * store is populated to enforce strict canonical-only rules loading.
     * Phase 5.1: true (default). Removed after next minor version.
     */
    allowLegacyClaudeMd: z.boolean().default(true),
  })
  .default(() => ({ allowLegacyClaudeMd: true }));

// Context Engine plugin provider config (Phase 7)
const ContextPluginProviderConfigSchema = z.object({
  /**
   * Module specifier for the plugin provider.
   * Accepts npm package names (e.g. "@company/nax-rag") or paths
   * relative to the project workdir (e.g. "./plugins/my-provider.js").
   */
  module: z.string().min(1),
  /**
   * Provider-specific config object passed to provider.init(config) on load.
   * Shape is provider-defined — the engine passes it through opaquely.
   */
  config: z.record(z.string(), z.unknown()).optional(),
  /**
   * Set false to skip this provider without removing the config entry.
   * Useful for temporarily disabling a provider for debugging.
   */
  enabled: z.boolean().default(true),
});

// Context Engine config (Phase 6: selective on; operators opt in per project)
const ContextV2ConfigSchema = z
  .object({
    /**
     * Enable Context Engine orchestrator.
     * Default: false — operators opt in by setting this true in their project config.
     * Phase 6: selective on; Phase 7: plugin providers available once enabled.
     */
    enabled: z.boolean().default(false),
    /**
     * Minimum score threshold — chunks below this are dropped as noise.
     * Phase 0: near-zero (0.1) so existing content is almost never filtered.
     * Post-GA: tuned upward once effectiveness signal data is available.
     */
    minScore: z.number().min(0).max(1).default(0.1),
    /** Pull tool configuration (Phase 4+) */
    pull: ContextV2PullConfigSchema,
    /** Canonical rules store configuration (Phase 5.1+) */
    rules: ContextV2RulesConfigSchema,
    /** Availability-fallback configuration (Phase 5.5+) */
    fallback: ContextV2FallbackConfigSchema,
    /**
     * External plugin provider registrations (Phase 7+).
     * Each entry loads a module that exports an IContextProvider-compatible object.
     * Empty by default — operators add providers for RAG, graph, or KB use cases.
     */
    pluginProviders: z.array(ContextPluginProviderConfigSchema).default([]),
    /**
     * Per-package token budget overrides (AC-59).
     * Keys are relative package paths from repoRoot (e.g. "packages/api").
     * Use "" for the root package (non-monorepo or repo-level override).
     * Values are per-stage budget maps: { "<stage>": <tokens> }.
     * Absent stages fall back to the default stage budget in STAGE_CONTEXT_MAP.
     *
     * Example:
     *   { "packages/api": { "execution": 15000, "tdd-implementer": 10000 } }
     */
    packageBudgets: z
      .record(z.string(), z.record(z.string().min(1), z.number().int().positive()))
      .default({}),
  })
  .default(() => ({
    enabled: false,
    minScore: 0.1,
    pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5, maxCallsPerRun: 50 },
    rules: { allowLegacyClaudeMd: true },
    fallback: { enabled: false, onQualityFailure: false, maxHopsPerStory: 2, map: {} },
    pluginProviders: [],
    packageBudgets: {},
  }));

const ContextConfigSchema = z.object({
  testCoverage: TestCoverageConfigSchema,
  autoDetect: ContextAutoDetectConfigSchema,
  fileInjection: z.enum(["keyword", "disabled"]).default("disabled"),
  featureEngine: FeatureContextEngineConfigSchema.optional(),
  /** Context Engine settings (Phase 6: enabled by default) */
  v2: ContextV2ConfigSchema,
});

const LlmRoutingConfigSchema = z.object({
  model: ConfiguredModelSchema.optional(),
  fallbackToKeywords: z.boolean().optional(),
  cacheDecisions: z.boolean().optional(),
  mode: z.enum(["one-shot", "per-story", "hybrid"]).optional(),
  batchMode: z.boolean().optional(), // deprecated, for backward compat
  timeoutMs: z.number().int().positive({ message: "llm.timeoutMs must be > 0" }).optional(),
  retries: z.number().int().min(0, { message: "llm.retries must be >= 0" }).optional(),
  retryDelayMs: z.number().int().min(0, { message: "llm.retryDelayMs must be >= 0" }).optional(),
});

const RoutingConfigSchema = z.object({
  strategy: z.enum(["keyword", "llm"]),
  llm: LlmRoutingConfigSchema.optional(),
});

const OptimizerConfigSchema = z.object({
  enabled: z.boolean(),
  strategy: z.enum(["rule-based", "llm", "noop"]).optional(),
});

const PluginConfigEntrySchema = z.object({
  module: z.string().min(1, "plugin.module must be non-empty"),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
});

const HooksConfigSchema = z.object({
  skipGlobal: z.boolean().optional(),
  hooks: z.record(z.string(), z.unknown()),
});

const InteractionConfigSchema = z.object({
  plugin: z.string().default("cli"),
  config: z.record(z.string(), z.unknown()).optional(),
  defaults: z.object({
    timeout: z.number().int().min(1000).max(3600000).default(600000),
    fallback: z.enum(["continue", "skip", "escalate", "abort"]).default("escalate"),
  }),
  triggers: z
    .record(
      z.string(),
      z.union([
        z.boolean(),
        z.object({
          enabled: z.boolean(),
          fallback: z.string().optional(),
          timeout: z.number().optional(),
        }),
      ]),
    )
    .default({}),
});

const StorySizeGateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxAcCount: z.number().int().min(1).max(50).default(10),
  maxDescriptionLength: z.number().int().min(100).max(10000).default(3000),
  maxBulletPoints: z.number().int().min(1).max(100).default(12),
  action: z.enum(["block", "warn", "skip"]).default("block"),
  maxReplanAttempts: z.number().int().min(1).default(3),
});

const PromptAuditConfigSchema = z.object({
  /** When true, every prompt sent to ACP is written to a file for auditing. Default: false. */
  enabled: z.boolean().default(false),
  /**
   * Directory to write audit files into.
   * Absolute path, or relative to workdir. Defaults to <workdir>/.nax/prompt-audit/ when absent.
   */
  dir: z.string().optional(),
});

const AgentConfigSchema = z.object({
  protocol: z.literal("acp").default("acp"),
  maxInteractionTurns: z.number().int().min(1).max(100).default(10),
  promptAudit: PromptAuditConfigSchema.default({ enabled: false }),
});

const PrecheckConfigSchema = z.object({
  storySizeGate: StorySizeGateConfigSchema,
});

export const PromptsConfigSchema = z.object({
  overrides: z
    .record(
      z
        .string()
        .refine(
          (key) => ["no-test", "test-writer", "implementer", "verifier", "single-session", "tdd-simple"].includes(key),
          {
            message: "Role must be one of: no-test, test-writer, implementer, verifier, single-session, tdd-simple",
          },
        ),
      z.string().min(1, "Override path must be non-empty"),
    )
    .optional(),
});

const ProjectProfileSchema = z.object({
  language: z.enum(["typescript", "javascript", "go", "rust", "python", "ruby", "java", "kotlin", "php"]).optional(),
  type: z.string().optional(),
  testFramework: z.string().optional(),
  lintTool: z.string().optional(),
});

const VALID_AGENT_TYPES = ["claude", "codex", "opencode", "cursor", "windsurf", "aider", "gemini"] as const;

const GenerateConfigSchema = z.object({
  agents: z.array(z.enum(VALID_AGENT_TYPES)).optional(),
});

const DebaterPersonaEnum = z.enum(["challenger", "pragmatist", "completionist", "security", "testability"]);

const DebaterSchema = z.object({
  agent: z.string().min(1, "debater.agent must be non-empty"),
  model: z.string().min(1, "debater.model must be non-empty").optional(),
  persona: DebaterPersonaEnum.optional(),
});

const toObject = (val: unknown): unknown => (val === undefined || val === null ? {} : val);

const RESOLVER_TYPES = ["synthesis", "majority-fail-closed", "majority-fail-open", "custom"] as const;

const makeResolverSchema = (defaultType: (typeof RESOLVER_TYPES)[number]) =>
  z.preprocess(
    toObject,
    z.object({
      type: z.enum(RESOLVER_TYPES).default(defaultType),
      agent: z.string().min(1).optional(),
      model: z.string().min(1).optional(),
      tieBreaker: z.string().min(1).optional(),
      maxPromptTokens: z.number().int().positive().optional(),
    }),
  );

const DebateStageConfigSchema = (defaults: {
  enabled: boolean;
  resolverType: (typeof RESOLVER_TYPES)[number];
  sessionMode: "one-shot" | "stateful";
  rounds: number;
}) =>
  z.preprocess(
    toObject,
    z.object({
      enabled: z.boolean().default(defaults.enabled),
      resolver: makeResolverSchema(defaults.resolverType),
      sessionMode: z.enum(["one-shot", "stateful"]).default(defaults.sessionMode),
      rounds: z.number().int().min(1).default(defaults.rounds),
      mode: z.enum(["panel", "hybrid"]).default("panel"),
      debaters: z.array(DebaterSchema).min(2, "debaters must have at least 2 entries").optional(),
      timeoutSeconds: z.number().int().positive().default(600),
      autoPersona: z.boolean().default(false),
    }),
  );

const DebateConfigSchema = z.preprocess(
  toObject,
  z.object({
    enabled: z.boolean().default(false),
    agents: z.number().int().min(2).default(3),
    maxConcurrentDebaters: z.number().int().min(1).max(10).default(2),
    stages: z.preprocess(
      toObject,
      z.object({
        plan: DebateStageConfigSchema({ enabled: true, resolverType: "synthesis", sessionMode: "stateful", rounds: 3 }),
        review: DebateStageConfigSchema({
          enabled: true,
          resolverType: "majority-fail-closed",
          sessionMode: "one-shot",
          rounds: 2,
        }),
        acceptance: DebateStageConfigSchema({
          enabled: false,
          resolverType: "majority-fail-closed",
          sessionMode: "one-shot",
          rounds: 1,
        }),
        rectification: DebateStageConfigSchema({
          enabled: false,
          resolverType: "synthesis",
          sessionMode: "one-shot",
          rounds: 1,
        }),
        escalation: DebateStageConfigSchema({
          enabled: false,
          resolverType: "majority-fail-closed",
          sessionMode: "one-shot",
          rounds: 1,
        }),
      }),
    ),
  }),
);

export const NaxConfigSchema = z
  .object({
    version: z.number().default(1),
    models: ModelMapSchema.default({
      claude: {
        fast: "haiku",
        balanced: "sonnet",
        powerful: "opus",
      },
    }),
    autoMode: AutoModeConfigSchema.default({
      enabled: true,
      defaultAgent: "claude",
      fallbackOrder: ["claude"],
      complexityRouting: {
        simple: "fast",
        medium: "balanced",
        complex: "powerful",
        expert: "powerful",
      },
      escalation: {
        enabled: true,
        tierOrder: [
          { tier: "fast", attempts: 5 },
          { tier: "balanced", attempts: 3 },
          { tier: "powerful", attempts: 2 },
        ],
        escalateEntireBatch: true,
      },
    }),
    routing: RoutingConfigSchema.default({
      strategy: "keyword",
      llm: {
        model: "fast",
        fallbackToKeywords: true,
        cacheDecisions: true,
        mode: "hybrid",
        timeoutMs: 30000,
      },
    }),
    execution: ExecutionConfigSchema.default({
      maxIterations: 10,
      iterationDelayMs: 2000,
      costLimit: 30.0,
      sessionTimeoutSeconds: 3600,
      verificationTimeoutSeconds: 600,
      maxStoriesPerFeature: 500,
      rectification: {
        enabled: true,
        maxRetries: 2,
        fullSuiteTimeoutSeconds: 300,
        maxFailureSummaryChars: 2000,
        abortOnIncreasingFailures: true,
        escalateOnExhaustion: true,
        rethinkAtAttempt: 2,
        urgencyAtAttempt: 3,
      },
      regressionGate: {
        enabled: true,
        timeoutSeconds: 300,
        acceptOnTimeout: true,
        mode: "deferred",
        maxRectificationAttempts: 3,
      },
      contextProviderTokenBudget: 2000,
      dangerouslySkipPermissions: true,
      permissionProfile: "unrestricted",
      smartTestRunner: true,
      storyIsolation: "shared",
    } as unknown as Parameters<typeof ExecutionConfigSchema.default>[0]),
    quality: QualityConfigSchema.default({
      requireTypecheck: true,
      requireLint: true,
      requireTests: true,
      scopeTestThreshold: 10,
      commands: {},
      autofix: {
        enabled: true,
        maxAttempts: 3,
        maxTotalAttempts: 12,
        rethinkAtAttempt: 2,
        urgencyAtAttempt: 3,
      },
      forceExit: false,
      detectOpenHandles: true,
      detectOpenHandlesRetries: 1,
      gracePeriodMs: 5000,
      drainTimeoutMs: 2000,
      shell: "/bin/sh",
      stripEnvVars: [
        "CLAUDECODE",
        "REPL_ID",
        "AGENT",
        "GITLAB_ACCESS_TOKEN",
        "GITHUB_TOKEN",
        "GITHUB_ACCESS_TOKEN",
        "GH_TOKEN",
        "CI_GIT_TOKEN",
        "CI_JOB_TOKEN",
        "BITBUCKET_ACCESS_TOKEN",
        "NPM_TOKEN",
        "NPM_AUTH_TOKEN",
        "YARN_NPM_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GEMINI_API_KEY",
        "COHERE_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GCLOUD_SERVICE_KEY",
        "AZURE_CLIENT_SECRET",
        "AZURE_TENANT_ID",
        "TELEGRAM_BOT_TOKEN",
        "SLACK_TOKEN",
        "SLACK_WEBHOOK_URL",
        "SENTRY_AUTH_TOKEN",
        "DATADOG_API_KEY",
      ],
      testing: {
        hermetic: true,
      },
    }),
    tdd: TddConfigSchema.default({
      maxRetries: 2,
      autoVerifyIsolation: true,
      autoApproveVerifier: true,
      strategy: "auto",
      sessionTiers: {
        testWriter: "balanced",
        verifier: "fast",
      },
      testWriterAllowedPaths: ["src/index.ts", "src/**/index.ts"],
      rollbackOnFailure: true,
      greenfieldDetection: true,
    }),
    constitution: ConstitutionConfigSchema.default({
      enabled: true,
      path: "constitution.md",
      maxTokens: 2000,
    }),
    review: ReviewConfigSchema.default({
      enabled: true,
      checks: ["typecheck", "lint"],
      commands: {},
      pluginMode: "per-story",
      audit: { enabled: false },
      blockingThreshold: "error",
      semantic: {
        modelTier: "balanced",
        diffMode: "embedded",
        resetRefOnRerun: false,
        rules: [],
        timeoutMs: 600_000,
        excludePatterns: [
          ":!test/",
          ":!tests/",
          ":!*_test.go",
          ":!*.test.ts",
          ":!*.spec.ts",
          ":!**/__tests__/",
          ":!.nax/",
          ":!.nax-pids",
        ],
      },
      dialogue: {
        enabled: false,
        maxClarificationsPerAttempt: 2,
        maxDialogueMessages: 20,
      },
    }),
    plan: PlanConfigSchema.default({
      model: "balanced",
      outputPath: "spec.md",
      timeoutSeconds: 600,
    }),
    acceptance: AcceptanceConfigSchema.default({
      enabled: true,
      maxRetries: 3,
      generateTests: true,
      testPath: ".nax-acceptance.test.ts",
      model: "fast",
      refinement: true,
      refinementConcurrency: 3,
      redGate: true,
      timeoutMs: 1800000,
      fix: {
        diagnoseModel: "fast",
        fixModel: "balanced",
        strategy: "diagnose-first",
        maxRetries: 2,
      },
      hardening: { enabled: true },
    }),
    context: ContextConfigSchema.default({
      fileInjection: "disabled",
      testCoverage: {
        enabled: true,
        detail: "names-and-counts",
        maxTokens: 500,
        scopeToStory: true,
      },
      autoDetect: {
        enabled: true,
        maxFiles: 5,
        traceImports: false,
      },
      v2: {
        enabled: false,
        minScore: 0.1,
        pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5, maxCallsPerRun: 50 },
        rules: { allowLegacyClaudeMd: true },
        fallback: { enabled: false, onQualityFailure: false, maxHopsPerStory: 2, map: {} },
        pluginProviders: [],
        packageBudgets: {},
      },
    }),
    optimizer: OptimizerConfigSchema.optional(),
    plugins: z.array(PluginConfigEntrySchema).optional(),
    disabledPlugins: z.array(z.string()).optional(),
    hooks: HooksConfigSchema.optional(),
    interaction: InteractionConfigSchema.optional().default({
      plugin: "cli",
      config: {},
      defaults: {
        timeout: 600000,
        fallback: "escalate",
      },
      triggers: {
        "security-review": true,
        "cost-warning": true,
      },
    }),
    agent: AgentConfigSchema.optional().default({
      protocol: "acp",
      maxInteractionTurns: 10,
      promptAudit: { enabled: false },
    }),
    precheck: PrecheckConfigSchema.optional().default({
      storySizeGate: {
        enabled: true,
        maxAcCount: 10,
        maxDescriptionLength: 3000,
        maxBulletPoints: 12,
        action: "block",
        maxReplanAttempts: 3,
      },
    }),
    prompts: PromptsConfigSchema.optional(),
    generate: GenerateConfigSchema.optional(),
    project: ProjectProfileSchema.optional(),
    debate: DebateConfigSchema.optional().default(() => ({
      enabled: false,
      agents: 3,
      maxConcurrentDebaters: 2,
      stages: {
        plan: {
          enabled: true,
          resolver: { type: "synthesis" as const },
          sessionMode: "stateful" as const,
          rounds: 3,
          mode: "panel" as const,
          timeoutSeconds: 600,
          autoPersona: false,
        },
        review: {
          enabled: true,
          resolver: { type: "majority-fail-closed" as const },
          sessionMode: "one-shot" as const,
          rounds: 2,
          mode: "panel" as const,
          timeoutSeconds: 600,
          autoPersona: false,
        },
        acceptance: {
          enabled: false,
          resolver: { type: "majority-fail-closed" as const },
          sessionMode: "one-shot" as const,
          rounds: 1,
          mode: "panel" as const,
          timeoutSeconds: 600,
          autoPersona: false,
        },
        rectification: {
          enabled: false,
          resolver: { type: "synthesis" as const },
          sessionMode: "one-shot" as const,
          rounds: 1,
          mode: "panel" as const,
          timeoutSeconds: 600,
          autoPersona: false,
        },
        escalation: {
          enabled: false,
          resolver: { type: "majority-fail-closed" as const },
          sessionMode: "one-shot" as const,
          rounds: 1,
          mode: "panel" as const,
          timeoutSeconds: 600,
          autoPersona: false,
        },
      },
    })),
    profile: z.string().default("default"),
  })
  .refine((data) => data.version === 1, {
    message: "Invalid version: expected 1",
    path: ["version"],
  });
