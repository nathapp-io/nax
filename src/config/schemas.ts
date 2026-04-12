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
  testFilePatterns: z.array(z.string()).default(["test/**/*.test.ts"]),
  fallback: z.enum(["import-grep", "full-suite"]).default("import-grep"),
});

const SMART_TEST_RUNNER_DEFAULT = {
  enabled: true,
  testFilePatterns: ["test/**/*.test.ts"],
  fallback: "import-grep" as const,
};

/** Coerces boolean → SmartTestRunnerConfig for backward compat */
const smartTestRunnerFieldSchema = z
  .preprocess((val) => {
    if (typeof val === "boolean") {
      return { enabled: val, testFilePatterns: ["test/**/*.test.ts"], fallback: "import-grep" };
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

const AnalyzeConfigSchema = z.object({
  llmEnhanced: z.boolean(),
  model: ModelTierSchema,
  fallbackToKeywords: z.boolean(),
  maxCodebaseSummaryTokens: z.number().int().positive(),
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
  excludePatterns: z
    .array(z.string())
    .default([
      ":!test/",
      ":!tests/",
      ":!*_test.go",
      ":!*.test.ts",
      ":!*.spec.ts",
      ":!**/__tests__/",
      ":!.nax/",
      ":!.nax-pids",
    ]),
});

export const ReviewDialogueConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxClarificationsPerAttempt: z.number().int().min(0).max(10).default(2),
  maxDialogueMessages: z.number().int().min(5).max(100).default(20),
});

const ReviewConfigSchema = z.object({
  enabled: z.boolean(),
  checks: z.array(z.enum(["typecheck", "lint", "test", "build", "semantic"])),
  commands: z.object({
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    test: z.string().optional(),
    build: z.string().optional(),
    lintFix: z.string().optional(),
    formatFix: z.string().optional(),
  }),
  pluginMode: z.enum(["per-story", "deferred"]).default("per-story"),
  semantic: SemanticReviewConfigSchema.optional(),
  dialogue: ReviewDialogueConfigSchema.default({
    enabled: false,
    maxClarificationsPerAttempt: 2,
    maxDialogueMessages: 20,
  }),
});

const PlanConfigSchema = z.object({
  model: ModelTierSchema,
  outputPath: z.string().min(1, "plan.outputPath must be non-empty"),
  timeoutSeconds: z.number().int().positive().default(600),
  /** Override timeout for decompose calls in seconds. Defaults to plan.timeoutSeconds. */
  decomposeTimeoutSeconds: z.number().int().min(30).max(1_800).optional(),
});

const AcceptanceFixConfigSchema = z.object({
  diagnoseModel: z.string().min(1, "acceptance.fix.diagnoseModel must be non-empty").default("fast"),
  fixModel: z.string().min(1, "acceptance.fix.fixModel must be non-empty").default("balanced"),
  strategy: z.enum(["diagnose-first", "implement-only"]).default("diagnose-first"),
  maxRetries: z.number().int().nonnegative().default(2),
});

export const AcceptanceConfigSchema = z.object({
  enabled: z.boolean(),
  maxRetries: z.number().int().nonnegative(),
  generateTests: z.boolean(),
  testPath: z.string().min(1, "acceptance.testPath must be non-empty"),
  command: z.string().optional(),
  model: z.enum(["fast", "balanced", "powerful"]).default("fast"),
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
  testPattern: z.string().default("**/*.test.{ts,js,tsx,jsx}"),
  scopeToStory: z.boolean().default(true),
});

const ContextAutoDetectConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxFiles: z.number().int().min(1).max(20).default(5),
  traceImports: z.boolean().default(false),
});

const ContextConfigSchema = z.object({
  testCoverage: TestCoverageConfigSchema,
  autoDetect: ContextAutoDetectConfigSchema,
  fileInjection: z.enum(["keyword", "disabled"]).default("disabled"),
});

const LlmRoutingConfigSchema = z.object({
  model: z.string().optional(),
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
  protocol: z.enum(["acp", "cli"]).default("acp"),
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
    analyze: AnalyzeConfigSchema.default({
      llmEnhanced: true,
      model: "balanced",
      fallbackToKeywords: true,
      maxCodebaseSummaryTokens: 5000,
    }),
    review: ReviewConfigSchema.default({
      enabled: true,
      checks: ["typecheck", "lint"],
      commands: {},
      pluginMode: "per-story",
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
        testPattern: "**/*.test.{ts,js,tsx,jsx}",
        scopeToStory: true,
      },
      autoDetect: {
        enabled: true,
        maxFiles: 5,
        traceImports: false,
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
