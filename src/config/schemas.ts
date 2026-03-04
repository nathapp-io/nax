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
  dangerouslySkipPermissions: z.boolean().default(true),
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
  }),
  forceExit: z.boolean().default(false),
  detectOpenHandles: z.boolean().default(true),
  detectOpenHandlesRetries: z.number().int().min(0).max(5).default(1),
  gracePeriodMs: z.number().int().min(500).max(30000).default(5000),
  drainTimeoutMs: z.number().int().min(0).max(10000).default(2000),
  shell: z.string().default("/bin/sh"),
  stripEnvVars: z.array(z.string()).default(["CLAUDECODE", "REPL_ID", "AGENT"]),
  environmentalEscalationDivisor: z.number().min(1).max(10).default(2),
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
});

const PlanConfigSchema = z.object({
  model: ModelTierSchema,
  outputPath: z.string().min(1, "plan.outputPath must be non-empty"),
});

const AcceptanceConfigSchema = z.object({
  enabled: z.boolean(),
  maxRetries: z.number().int().nonnegative(),
  generateTests: z.boolean(),
  testPath: z.string().min(1, "acceptance.testPath must be non-empty"),
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

const PrecheckConfigSchema = z.object({
  storySizeGate: StorySizeGateConfigSchema,
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
    hooks: HooksConfigSchema.optional(),
    interaction: InteractionConfigSchema.optional(),
    precheck: PrecheckConfigSchema.optional(),
  })
  .refine((data) => data.version === 1, {
    message: "Invalid version: expected 1",
    path: ["version"],
  });
