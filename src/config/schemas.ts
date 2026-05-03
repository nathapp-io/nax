/**
 * Zod Schema Definitions
 *
 * Runtime validation schemas for nax configuration.
 * Sub-schemas are extracted into schemas-*.ts files.
 */

import { z } from "zod";
import { ContextConfigSchema } from "./schemas-context";
import { DebateConfigSchema } from "./schemas-debate";
import {
  AutoModeConfigSchema,
  ConstitutionConfigSchema,
  ExecutionConfigSchema,
  QualityConfigSchema,
  TddConfigSchema,
} from "./schemas-execution";
import {
  AcceptanceConfigSchema,
  AgentConfigSchema,
  GenerateConfigSchema,
  HooksConfigSchema,
  InteractionConfigSchema,
  OptimizerConfigSchema,
  PlanConfigSchema,
  PluginConfigEntrySchema,
  PrecheckConfigSchema,
  ProjectProfileSchema,
  PromptsConfigSchema,
  RoutingConfigSchema,
} from "./schemas-infra";
import { ModelMapSchema } from "./schemas-model";
import { ReviewConfigSchema } from "./schemas-review";

// Re-export named schemas consumed by other modules (via config/schema.ts barrel)
export { AcceptanceConfigSchema } from "./schemas-infra";
export { AdversarialReviewConfigSchema, ReviewDialogueConfigSchema } from "./schemas-review";
export { ContextV2ConfigSchema } from "./schemas-context";
export { PromptsConfigSchema } from "./schemas-infra";

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
      permissionProfile: "unrestricted",
      smartTestRunner: true,
      worktreeDependencies: {
        mode: "off",
        setupCommand: null,
      },
      storyIsolation: "shared",
    } as unknown as Parameters<typeof ExecutionConfigSchema.default>[0]),
    quality: QualityConfigSchema.default({
      requireTypecheck: true,
      requireLint: true,
      requireTests: true,
      scopeTestThreshold: 10,
      commands: {},
      lintOutput: {
        format: "auto",
      },
      typecheckOutput: {
        format: "auto",
      },
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
      gateLLMChecksOnMechanicalPass: true,
      checks: ["typecheck", "lint"],
      commands: {},
      pluginMode: "per-story",
      audit: { enabled: false },
      blockingThreshold: "error",
      semantic: {
        model: "balanced",
        diffMode: "ref",
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
        findingsV2: false,
        cycleV2: false,
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
        rules: { allowLegacyClaudeMd: false, budgetTokens: 8192 },
        pluginProviders: [],
        stages: {},
        deterministic: false,
        session: { retentionDays: 7, archiveOnFeatureArchive: true },
        staleness: { enabled: true, maxStoryAge: 10, scoreMultiplier: 0.4 },
        providers: { historyScope: "package", neighborScope: "package", crossPackageDepth: 1 },
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
      default: "claude",
      maxInteractionTurns: 20,
      promptAudit: { enabled: false },
      fallback: { enabled: false, map: {}, maxHopsPerStory: 2, onQualityFailure: false, rebuildContext: true },
      acp: { promptRetries: 0 },
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
