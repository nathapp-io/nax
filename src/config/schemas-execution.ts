/**
 * Execution, quality, TDD, and constitution schemas for nax configuration.
 * Extracted from schemas.ts to stay within the 600-line file limit.
 */

import { z } from "zod";
import { ConfiguredModelSchema, ModelTierSchema, TierConfigSchema } from "./schemas-model";

const AutoModeConfigSchema = z.object({
  enabled: z.boolean(),
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

const WorktreeDependenciesConfigSchema = z
  .object({
    mode: z.enum(["inherit", "provision", "off"]).default("off"),
    setupCommand: z.string().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.mode !== "provision" && value.setupCommand !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["setupCommand"],
        message: "execution.worktreeDependencies.setupCommand requires mode 'provision'",
      });
    }
  });

export const ExecutionConfigSchema = z.object({
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
  worktreeDependencies: WorktreeDependenciesConfigSchema.default({
    mode: "off",
    setupCommand: null,
  }),
  storyIsolation: z.enum(["shared", "worktree"]).default("shared"),
});

export const QualityConfigSchema = z.object({
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

export const TddConfigSchema = z.object({
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

export const ConstitutionConfigSchema = z.object({
  enabled: z.boolean(),
  path: z.string().min(1, "constitution.path must be non-empty"),
  maxTokens: z.number().int().positive({ message: "constitution.maxTokens must be > 0" }),
  skipGlobal: z.boolean().optional(),
});

export { AutoModeConfigSchema };
