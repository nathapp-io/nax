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

const ModelMapSchema = z.object({
  fast: ModelEntrySchema,
  balanced: ModelEntrySchema,
  powerful: ModelEntrySchema,
});

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
  sessionTimeoutSeconds: z.number().int().positive({ message: "sessionTimeoutSeconds must be > 0" }),
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
  permissionProfile: z.enum(["unrestricted", "safe", "scoped"]).optional(),
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
});

const QualityConfigSchema = z.object({
  requireTypecheck: z.boolean(),
  requireLint: z.boolean(),
  requireTests: z.boolean(),
  commands: z.object({
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    test: z.string().optional(),
    testScoped: z.string().optional(),
    lintFix: z.string().optional(),
    formatFix: z.string().optional(),
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
  environmentalEscalationDivisor: z.number().min(1).max(10).default(2),
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

const ReviewConfigSchema = z.object({
  enabled: z.boolean(),
  checks: z.array(z.enum(["typecheck", "lint", "test"])),
  commands: z.object({
    typecheck: z.string().optional(),
    lint: z.string().optional(),
    test: z.string().optional(),
  }),
  pluginMode: z.enum(["per-story", "deferred"]).default("per-story"),
});

const PlanConfigSchema = z.object({
  model: ModelTierSchema,
  outputPath: z.string().min(1, "plan.outputPath must be non-empty"),
});

export const AcceptanceConfigSchema = z.object({
  enabled: z.boolean(),
  maxRetries: z.number().int().nonnegative(),
  generateTests: z.boolean(),
  testPath: z.string().min(1, "acceptance.testPath must be non-empty"),
  model: z.enum(["fast", "balanced", "powerful"]).default("fast"),
  refinement: z.boolean().default(true),
  redGate: z.boolean().default(true),
  testStrategy: z.enum(["unit", "component", "cli", "e2e", "snapshot"]).optional(),
  testFramework: z.string().min(1, "acceptance.testFramework must be non-empty").optional(),
  timeoutMs: z.number().int().min(30000).max(3600000).default(1800000),
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

const AdaptiveRoutingConfigSchema = z.object({
  minSamples: z.number().int().positive({ message: "adaptive.minSamples must be > 0" }),
  costThreshold: z.number().min(0).max(1, { message: "adaptive.costThreshold must be 0-1" }),
  fallbackStrategy: z.enum(["keyword", "llm", "manual"]),
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

const RoutingConfigSchema = z
  .object({
    strategy: z.enum(["keyword", "llm", "manual", "adaptive", "custom"]),
    customStrategyPath: z.string().optional(),
    adaptive: AdaptiveRoutingConfigSchema.optional(),
    llm: LlmRoutingConfigSchema.optional(),
  })
  .refine(
    (data) => {
      // If strategy is "custom", customStrategyPath is required
      if (data.strategy === "custom" && !data.customStrategyPath) {
        return false;
      }
      return true;
    },
    {
      message: "routing.customStrategyPath is required when strategy is 'custom'",
      path: ["customStrategyPath"],
    },
  );

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
  maxAcCount: z.number().int().min(1).max(50).default(6),
  maxDescriptionLength: z.number().int().min(100).max(10000).default(2000),
  maxBulletPoints: z.number().int().min(1).max(100).default(8),
});

const AgentConfigSchema = z.object({
  protocol: z.enum(["acp", "cli"]).default("acp"),
  maxInteractionTurns: z.number().int().min(1).max(100).default(10),
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

const DecomposeConfigSchema = z.object({
  trigger: z.enum(["auto", "confirm", "disabled"]).default("auto"),
  maxAcceptanceCriteria: z.number().int().min(1).default(6),
  maxSubstories: z.number().int().min(1).default(5),
  maxSubstoryComplexity: z.enum(["simple", "medium", "complex", "expert"]).default("medium"),
  maxRetries: z.number().int().min(0).default(2),
  model: z.string().min(1).default("balanced"),
});

export const NaxConfigSchema = z
  .object({
    version: z.number(),
    models: ModelMapSchema,
    autoMode: AutoModeConfigSchema,
    routing: RoutingConfigSchema,
    execution: ExecutionConfigSchema,
    quality: QualityConfigSchema,
    tdd: TddConfigSchema,
    constitution: ConstitutionConfigSchema,
    analyze: AnalyzeConfigSchema,
    review: ReviewConfigSchema,
    plan: PlanConfigSchema,
    acceptance: AcceptanceConfigSchema,
    context: ContextConfigSchema,
    optimizer: OptimizerConfigSchema.optional(),
    plugins: z.array(PluginConfigEntrySchema).optional(),
    disabledPlugins: z.array(z.string()).optional(),
    hooks: HooksConfigSchema.optional(),
    interaction: InteractionConfigSchema.optional(),
    agent: AgentConfigSchema.optional(),
    precheck: PrecheckConfigSchema.optional(),
    prompts: PromptsConfigSchema.optional(),
    decompose: DecomposeConfigSchema.optional(),
  })
  .refine((data) => data.version === 1, {
    message: "Invalid version: expected 1",
    path: ["version"],
  });
