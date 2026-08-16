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
    /** Reset behaviour for failed stories on re-run (ADR-025). */
    resetMode: z.enum(["initial", "last"]).default("initial"),
  }),
});

export const AutoRouteUpgradeConfigSchema = z.object({
  escalationRate: z.number().min(0).max(1).default(0.3),
  mismatchRate: z.number().min(0).max(1).default(0.25),
});

export const AutoRouteDowngradeConfigSchema = z.object({
  firstPassRate: z.number().min(0).max(1).default(0.9),
  escalationRate: z.number().min(0).max(1).default(0.05),
});

export const AutoRouteConfigSchema = z.object({
  enabled: z.boolean().default(false),
  minSamples: z.number().int().min(1).default(8),
  upgrade: AutoRouteUpgradeConfigSchema.default({
    escalationRate: 0.3,
    mismatchRate: 0.25,
  }),
  downgrade: AutoRouteDowngradeConfigSchema.default({
    firstPassRate: 0.9,
    escalationRate: 0.05,
  }),
});

export const RectificationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Total iteration cap for the unified fix cycle (shared by story-orchestrator
   * + regression cycles). Per-strategy caps are the granular bound; this is the
   * loose ceiling. */
  maxAttemptsTotal: z.number().int().min(1).max(50).default(12),
  /** Default per-strategy cap for LLM-driven strategies (autofix-implementer,
   * autofix-test-writer, full-suite-rectify). Mechanical strategies stay at 1. */
  maxAttemptsPerStrategy: z.number().int().min(1).max(20).default(3),
  fullSuiteTimeoutSeconds: z.number().int().min(10).max(600).default(120),
  maxFailureSummaryChars: z.number().int().min(500).max(10000).default(2000),
  abortOnIncreasingFailures: z.boolean().default(true),
  /** Number of consecutive iterations whose finding count must increase
   * (findingsAfter > findingsBefore) before `abortOnIncreasingFailures` bails.
   * 1 = bail on the first regressing iteration (legacy behaviour); higher
   * values tolerate transient regressions (e.g. a tightened test temporarily
   * surfacing more verifier failures before the implementer fixes the source). */
  consecutiveIncreasesToBail: z.number().int().min(1).max(10).default(2),
  /** Abort rectification when no progress is made for several consecutive iterations
   * (US-1496). Predicate wiring lives in US-002; this field is the resolved config
   * knob. (default: true) */
  abortOnNoProgress: z.boolean().default(true),
  /** Number of consecutive no-progress iterations required before `abortOnNoProgress`
   * bails. One higher than the count bail's default of 2 because the no-progress
   * predicate fires on a much wider shape — the true coverage between 179 and 695
   * iterations cannot be measured until post-#1496 telemetry accrues. (default: 3) */
  consecutiveNoProgressToBail: z.number().int().min(1).max(10).default(3),
  /** Bound the rectification budget to one (story, tier) pair so a tier escalation
   * yields a fresh budget — a more capable model gets real attempts instead of
   * inheriting the prior tier's exhausted state. (default: true) */
  storyScopedFixBudget: z.boolean().default(true),
  // Per-strategy attempt counters — reset when a new strategy runs.
  // Under maxAttemptsPerStrategy=3: rethink on attempt 2, urgency on attempt 3 (final).
  rethinkAtAttempt: z.number().int().min(1).default(2),
  urgencyAtAttempt: z.number().int().min(1).default(3),
});

export const RegressionGateConfigSchema = z.object({
  enabled: z.boolean().default(true),
  timeoutSeconds: z.number().int().min(10).max(600).default(120),
  acceptOnTimeout: z.boolean().default(true),
  mode: z.enum(["deferred", "per-story", "disabled"]).default("deferred"),
});

const SmartTestRunnerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Optional — undefined means user did not set this; resolver falls through
   * to auto-detection then DEFAULT_TEST_FILE_PATTERNS. (ADR-009)
   */
  testFilePatterns: z.array(z.string()).optional(),
  fallback: z.enum(["import-grep", "full-suite"]).default("import-grep"),
  /**
   * Max test files scanned (post-filter) before truncating. Single source of
   * truth for both the import-grep fallback scan (smart-runner) and the
   * test-coverage context scan (test-scanner).
   */
  maxScanFiles: z.number().int().min(1).max(5000).default(200),
});

const SMART_TEST_RUNNER_DEFAULT = {
  enabled: true,
  fallback: "import-grep" as const,
  maxScanFiles: 200,
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
        code: "custom",
        path: ["setupCommand"],
        message: "execution.worktreeDependencies.setupCommand requires mode 'provision'",
      });
    }
  });

/**
 * Flake-detection probe config. Controls the isolation re-run mechanic
 * (`src/verification/flake-probe.ts`) used to distinguish deterministic
 * failures from transient flakes before attributing them to a story.
 */
const FlakeDetectionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Number of isolation re-runs per probe. Default 2 (one fail + one pass = flaky). */
  probeRuns: z.number().int().min(1).max(20).default(2),
  /** Upper bound on probes accumulated per gate (budget cap across stories). */
  maxProbesPerGate: z.number().int().min(1).max(100).default(5),
  /** Per-probe subprocess timeout in seconds. */
  probeTimeoutSeconds: z.number().int().min(5).max(600).default(60),
});

/**
 * Mutation-check config (US-001). Opt-in mutation-testing spot-check that runs
 * after GREEN passes to verify the test suite actually catches real defects.
 * `enabled` defaults to `false` so existing runs are unaffected.
 */
const MutationCheckConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Max mutants per story (budget cap for the spot-check). */
  maxMutants: z.number().int().min(1).max(50).default(3),
  /** Per-mutant subprocess timeout in seconds. */
  timeoutSeconds: z.number().int().min(5).max(600).default(60),
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
  // NOTE: the Phase 2 `permissions` block (per-stage overrides) deliberately has
  // no schema entry. It was accepted and validated here while nothing in src/
  // read it, so a user could state a permission policy and get no enforcement.
  // `rejectUnimplementedPermissionsBlock` now fails the load instead. Re-add
  // this alongside the resolver when GitHub #374 lands.
  smartTestRunner: smartTestRunnerFieldSchema,
  worktreeDependencies: WorktreeDependenciesConfigSchema.default({
    mode: "off",
    setupCommand: null,
  }),
  storyIsolation: z.enum(["shared", "worktree"]).default("shared"),
  flakeDetection: FlakeDetectionConfigSchema.default({
    enabled: true,
    probeRuns: 2,
    maxProbesPerGate: 5,
    probeTimeoutSeconds: 60,
  }),
  mutationCheck: MutationCheckConfigSchema.default({
    enabled: false,
    maxMutants: 3,
    timeoutSeconds: 60,
  }),
});

/**
 * BUG-20 — derived, not hand-written. The outer `NaxConfigSchema`'s
 * `execution: ExecutionConfigSchema.default({...})` literal (schemas.ts) must
 * not hardcode this number a second time: zod does not re-parse a
 * `.default()` value, so a hand-written literal there previously drifted
 * (600s) from this field's own default (300s) — `parse({})` yielded one
 * value, a config that merely supplies a partial `execution` object yielded
 * the other.
 */
export const DEFAULT_VERIFICATION_TIMEOUT_SECONDS =
  ExecutionConfigSchema.shape.verificationTimeoutSeconds.parse(undefined);

export const QualityConfigSchema = z.object({
  scopeTestThreshold: z.number().int().min(0).default(10),
  commands: z
    .object({
      typecheck: z.string().optional(),
      lint: z.string().optional(),
      lintScoped: z.string().optional(),
      test: z.string().optional(),
      testScoped: z.string().optional(),
      lintFix: z.string().optional(),
      lintFixScoped: z.string().optional(),
      formatFix: z.string().optional(),
      formatFixScoped: z.string().optional(),
      build: z.string().optional(),
      /**
       * One-time package initialization (e.g. `uv sync`, `bun install`,
       * `go mod download`). Runs once per newly-created package directory
       * (story.workdir that did not exist at run start), after the implementer
       * scaffolds the manifest and before the first verify/test gate. Layerable
       * per-package via `.nax/mono/<pkg>/config.json`.
       */
      setup: z.string().optional(),
    })
    .default({}),
  lintOutput: z
    .object({
      format: z.enum(["auto", "eslint-json", "biome-json", "text", "none"]).default("auto"),
    })
    .default({ format: "auto" }),
  typecheckOutput: z
    .object({
      format: z.enum(["auto", "tsc", "text", "none"]).default("auto"),
    })
    .default({ format: "auto" }),
  autofix: z
    .object({
      /** Whether autofix-implementer + autofix-test-writer strategies participate
       * in the rectification cycle. Cycle-level caps live under
       * execution.rectification.{maxAttemptsTotal,maxAttemptsPerStrategy}. */
      enabled: z.boolean().default(true),
      /** Prompt-text display only: "X attempts available before escalation".
       * Not enforced — the real cap is execution.rectification.maxAttemptsPerStrategy. */
      maxAttempts: z.number().int().min(1).default(3),
      enforceTestWriterIsolation: z.boolean().default(true),
    })
    .default({
      enabled: true,
      maxAttempts: 3,
      enforceTestWriterIsolation: true,
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
  strategy: z.enum(["auto", "strict", "lite", "off"]).default("auto"),
  sessionTiers: z
    .object({
      // ConfiguredModel = tier string ("fast") OR { agent, model } cross-agent pin.
      testWriter: ConfiguredModelSchema.default("fast"),
      verifier: ConfiguredModelSchema.default("fast"),
      // implementer is routing-driven (story.routing.modelTier + escalation); this
      // field is intentionally NOT consumed. Kept optional so legacy configs parse.
      implementer: ConfiguredModelSchema.optional(),
    })
    // Explicit default avoids Zod v4 behavior where .default({}) bypasses inner defaults.
    .default({ testWriter: "fast", verifier: "fast" }),
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
