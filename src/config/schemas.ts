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
  AutoRouteConfigSchema,
  ConstitutionConfigSchema,
  ExecutionConfigSchema,
  QualityConfigSchema,
  TddConfigSchema,
} from "./schemas-execution";
import {
  AcceptanceConfigSchema,
  AgentConfigSchema,
  CuratorConfigSchema,
  DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG,
  DEFAULT_AGENT_TIMEOUT_RETRY_CONFIG,
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
import { ReportersConfigSchema } from "./schemas-reporters";
import { AdversarialReviewConfigSchema, ReviewConfigSchema } from "./schemas-review";

// Re-export named schemas consumed by other modules (via config/schema.ts barrel)
export { AcceptanceConfigSchema, PlanConfigSchema } from "./schemas-infra";
export { AdversarialReviewConfigSchema } from "./schemas-review";
export { ContextV2ConfigSchema } from "./schemas-context";
export { PromptsConfigSchema } from "./schemas-infra";

export const NaxConfigSchema = z
  .object({
    name: z
      .string()
      .default("")
      .refine((v) => v === "" || /^[a-z0-9_-]+$/.test(v), {
        message: "name must contain only lowercase letters, digits, hyphens, and underscores",
      })
      .refine((v) => v === "" || (!v.startsWith(".") && !v.startsWith("_")), {
        message: "name must not start with '.' or '_'",
      })
      .refine((v) => !["global", "_archive"].includes(v), {
        message: "name 'global' and '_archive' are reserved",
      })
      .refine((v) => v === "" || v.length <= 64, {
        message: "name must be at most 64 characters",
      }),
    outputDir: z
      .string()
      .optional()
      .refine((v) => v === undefined || v.startsWith("/") || v.startsWith("~/"), {
        message: "outputDir must be absolute or start with ~/",
      }),
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
        resetMode: "initial",
      },
    }),
    autoRoute: AutoRouteConfigSchema.default({
      enabled: false,
      minSamples: 8,
      upgrade: { escalationRate: 0.3, mismatchRate: 0.25 },
      downgrade: { firstPassRate: 0.9, escalationRate: 0.05 },
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
      agents: { enabled: true, strategy: "off", profiles: [] },
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
        maxAttemptsTotal: 12,
        maxAttemptsPerStrategy: 3,
        fullSuiteTimeoutSeconds: 300,
        maxFailureSummaryChars: 2000,
        abortOnIncreasingFailures: true,
        consecutiveIncreasesToBail: 2,
        escalateOnExhaustion: true,
        rethinkAtAttempt: 2,
        urgencyAtAttempt: 3,
      },
      regressionGate: {
        enabled: true,
        timeoutSeconds: 300,
        acceptOnTimeout: true,
        mode: "deferred",
      },
      contextProviderTokenBudget: 2000,
      permissionProfile: "unrestricted",
      smartTestRunner: true,
      worktreeDependencies: {
        mode: "off",
        setupCommand: null,
      },
      storyIsolation: "shared",
      flakeDetection: {
        enabled: true,
        probeRuns: 2,
        maxProbesPerGate: 5,
        probeTimeoutSeconds: 60,
      },
      mutationCheck: {
        enabled: false,
        maxMutants: 3,
        timeoutSeconds: 60,
      },
    } as unknown as Parameters<typeof ExecutionConfigSchema.default>[0]),
    quality: QualityConfigSchema.default({
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
        enforceTestWriterIsolation: true,
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
        testWriter: "fast",
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
      audit: { enabled: false },
      conflictDetection: { enabled: true, maxOscillations: 2 },
      blockingThreshold: "error",

      pluginMode: "observational",
      semantic: {
        model: "balanced",
        diffMode: "ref",
        resetRefOnRerun: false,
        rules: [],
        timeoutMs: 600_000,
        demandInspectionTrail: true,
        recurrenceDemotion: { enabled: false, maxBlockingRounds: 2 },
        substantiation: {
          requote: true,
          maxRequotes: 5,
        },
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
      // Derived from the schema's own defaults (SSOT, issue #1338) so new
      // AdversarialReviewConfigSchema fields flow in automatically instead of
      // being hand-copied here. `substantiation` is schema-optional (no
      // `.default()`), so it is spread in explicitly to keep the default shape
      // identical; consumers treat an absent value the same via `?? true` / `?? 5`.
      adversarial: {
        ...AdversarialReviewConfigSchema.parse({}),
        substantiation: {
          requote: true,
          maxRequotes: 5,
        },
      },
    }),
    plan: PlanConfigSchema.default({
      model: "balanced",
      outputPath: "spec.md",
      timeoutSeconds: 600,
      citationThreshold: 0.5,
      criticModel: "fast",
      specGuard: false,
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
        providerTimeoutMs: 5000,
        pull: { enabled: false, allowedTools: [], maxCallsPerSession: 5, maxCallsPerRun: 50 },
        rules: { allowLegacyClaudeMd: false, budgetTokens: 8192 },
        pluginProviders: [],
        stages: {},
        deterministic: false,
        session: { retentionDays: 7, archiveOnFeatureArchive: true },
        staleness: { enabled: true, maxStoryAge: 10, scoreMultiplier: 0.4 },
        providers: { historyScope: "package", neighborScope: "package", crossPackageDepth: 1, maxGlobFiles: 500 },
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
      idleWatchdog: DEFAULT_AGENT_IDLE_WATCHDOG_CONFIG,
      timeoutRetry: DEFAULT_AGENT_TIMEOUT_RETRY_CONFIG,
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
    prompts: PromptsConfigSchema.default({ behavioralGuardrails: "lite" }),
    generate: GenerateConfigSchema.optional(),
    project: ProjectProfileSchema.optional(),
    debate: DebateConfigSchema.optional().default(() => ({
      enabled: false,
      agents: 3,
      maxConcurrentDebaters: 2,
      grounder: { model: "fast" as const, timeoutSeconds: 1800 },
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
    curator: CuratorConfigSchema.optional(),
    autoPr: z
      .object({
        enabled: z.boolean().default(false),
        draft: z.boolean().default(true),
      })
      .optional()
      .default({ enabled: false, draft: true }),
    finish: z
      .object({
        autoFlow: z
          .object({
            enabled: z.boolean().default(false),
            flowPath: z.string().default("flows/nax-finish/nax-finish.flow.ts"),
            defaultAgent: z.string().nullable().default(null),
            /**
             * acpx `--model`, a run-wide *fallback*. acpx resolves a node's
             * model as `node.model ?? agent.model ?? --model`, so this only
             * reaches nodes whose agent entry pins no model of its own — i.e.
             * the `fix_*` nodes, not the profile-pinned reviewers.
             *
             * Opt-in (null) because that precedence needs an acpx build that
             * accepts a `model` on agent entries. On a build without it there is
             * nothing above `--model` in the chain, so it would override the
             * reviewers too.
             */
            model: z.string().min(1, "model must be non-empty").nullable().default(null),
            reviewers: z
              .object({
                spec: z.string().nullable().default(null),
                quality: z.string().nullable().default(null),
              })
              .default({ spec: null, quality: null }),
            escalate: z.object({ telegram: z.boolean().default(true) }).default({ telegram: true }),
            notify: z
              .object({ mode: z.enum(["escalation", "always", "off"]).default("escalation") })
              .default({ mode: "escalation" }),
            // Wall-clock caps. Every one of these bounds a subprocess the flow
            // awaits; without them a hung gate stalls the whole run's
            // completion phase, which has no timeout of its own.
            timeouts: z
              .object({
                /** Per acceptance-test group. */
                acceptanceMs: z.number().int().positive().default(600_000),
                /** Per quality gate (build / typecheck / lint / test / format). */
                gateMs: z.number().int().positive().default(900_000),
                /** Whole `acpx flow run` subprocess. */
                flowMs: z.number().int().positive().default(5_400_000),
                /**
                 * Per flow *step* (one review or fix agent turn), passed to acpx as
                 * `--timeout`. null keeps acpx's own 15-minute default, which a
                 * large-diff review can exceed.
                 */
                stepMs: z.number().int().positive().nullable().default(null),
              })
              .default({ acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null }),
          })
          .default({
            enabled: false,
            flowPath: "flows/nax-finish/nax-finish.flow.ts",
            defaultAgent: null,
            model: null,
            reviewers: { spec: null, quality: null },
            escalate: { telegram: true },
            notify: { mode: "escalation" },
            timeouts: { acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null },
          }),
      })
      .default({
        autoFlow: {
          enabled: false,
          flowPath: "flows/nax-finish/nax-finish.flow.ts",
          defaultAgent: null,
          model: null,
          reviewers: { spec: null, quality: null },
          escalate: { telegram: true },
          notify: { mode: "escalation" },
          timeouts: { acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null },
        },
      }),
    reporters: ReportersConfigSchema,
    profile: z.string().default("default"),
    profileChain: z.array(z.string()).default([]),
  })
  .refine((data) => data.version === 1, {
    message: "Invalid version: expected 1",
    path: ["version"],
  })
  .superRefine((data, ctx) => {
    // Cross-section: each tierOrder rung's agent (when set) must exist in config.models
    const tierOrder = data.autoMode?.escalation?.tierOrder ?? [];
    const knownAgents = Object.keys(data.models ?? {});
    for (const [i, rung] of tierOrder.entries()) {
      if (rung.agent === undefined) continue;
      if (!knownAgents.includes(rung.agent)) {
        ctx.addIssue({
          code: "custom",
          path: ["autoMode", "escalation", "tierOrder", i, "agent"],
          message: `Agent "${rung.agent}" is not defined in config.models (known: ${knownAgents.join(", ")})`,
        });
      } else {
        const agentTiers = data.models?.[rung.agent] ?? {};
        if (!(rung.tier in agentTiers)) {
          ctx.addIssue({
            code: "custom",
            path: ["autoMode", "escalation", "tierOrder", i, "tier"],
            message: `Tier "${rung.tier}" is not defined for agent "${rung.agent}" in config.models`,
          });
        }
      }
    }
    // Profile↔ladder binding: every profile's target must map to a rung in tierOrder
    const profiles = data.routing.agents?.profiles ?? [];
    for (const [pi, profile] of profiles.entries()) {
      const { agent: pAgent, model: pModel } = profile.target;
      const hasMatchingRung = tierOrder.some((r) => r.tier === pModel && r.agent === pAgent);
      if (!hasMatchingRung) {
        ctx.addIssue({
          code: "custom",
          path: ["routing", "agents", "profiles", pi, "target"],
          message: `Profile "${profile.id}" target (${pAgent}@${pModel}) has no matching rung in autoMode.escalation.tierOrder — escalation from this profile has no defined path. To fix: agent-qualify the ladder by adding a rung { "tier": "${pModel}", "agent": "${pAgent}", "attempts": <n> } (and an agent on every other rung) to autoMode.escalation.tierOrder.`,
        });
      }
      // Cross-section: profile target agent must exist in config.models
      if (!knownAgents.includes(pAgent)) {
        ctx.addIssue({
          code: "custom",
          path: ["routing", "agents", "profiles", pi, "target", "agent"],
          message: `Profile "${profile.id}" target agent "${pAgent}" is not defined in config.models`,
        });
      }
    }
  });
