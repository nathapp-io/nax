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
  DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
  ExecutionConfigSchema,
  QualityConfigSchema,
  RectificationConfigSchema,
  RegressionGateConfigSchema,
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
import { ConfiguredModelSchema, ModelMapSchema } from "./schemas-model";
import { ReportersConfigSchema } from "./schemas-reporters";
import { AdversarialReviewConfigSchema, ReviewConfigSchema } from "./schemas-review";

export { ContextConfigSchema, ContextV2ConfigSchema } from "./schemas-context";
// Re-export named schemas consumed by other modules (via config/schema.ts barrel)
export { AcceptanceConfigSchema, PlanConfigSchema, PromptsConfigSchema } from "./schemas-infra";
export { AdversarialReviewConfigSchema } from "./schemas-review";

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
          { tier: "fast", attempts: 2 },
          { tier: "balanced", attempts: 2 },
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
      // BUG-20 — derived from the field's own default, not hand-written; see
      // DEFAULT_VERIFICATION_TIMEOUT_SECONDS in schemas-execution.ts.
      verificationTimeoutSeconds: DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
      maxStoriesPerFeature: 500,
      // BUG-20 — derived, not hand-written (same rationale as `context` below):
      // a literal here would drift from RectificationConfigSchema's own
      // per-field defaults, as it already had (fullSuiteTimeoutSeconds: 300
      // here vs. 120 in the inner schema).
      rectification: RectificationConfigSchema.parse({}),
      // BUG-20 — derived, not hand-written; same rationale (timeoutSeconds
      // drifted to 300 here vs. 120 in RegressionGateConfigSchema).
      regressionGate: RegressionGateConfigSchema.parse({}),
      contextProviderTokenBudget: 2000,
      permissionProfile: "unrestricted",
      smartTestRunner: true,
      worktreeDependencies: {
        mode: "off",
        setupCommand: null,
        timeoutSeconds: 300,
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
      conflictDetection: { enabled: true, maxOscillations: 2, maxCrossAttemptRecurrences: 2 },
      blockingThreshold: "error",

      pluginMode: "observational",
      parseRetryMaxAttempts: 3,
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
    // Derived, not hand-written. Zod does not re-parse a `.default()` value, so a
    // literal here would shadow every inner `.default()` in ContextConfigSchema —
    // any field added there but forgotten here would be missing from
    // `NaxConfigSchema.parse({})` (and therefore from DEFAULT_CONFIG) while still
    // resolving correctly when the operator supplies the parent partially. That
    // asymmetry is invisible to a green suite. Re-parsing keeps one source of truth.
    context: ContextConfigSchema.default(() => ContextConfigSchema.parse({})),
    optimizer: OptimizerConfigSchema.optional(),
    plugins: z.array(PluginConfigEntrySchema).optional(),
    disabledPlugins: z.array(z.string()).optional(),
    hooks: HooksConfigSchema.optional(),
    interaction: InteractionConfigSchema.optional().default({
      plugin: "cli",
      config: {},
      // No top-level `fallback` (BUG-48 / D-9) — see the matching comment on
      // InteractionConfigSchema.defaults.fallback in schemas-infra.ts.
      defaults: {
        timeout: 600000,
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
      acp: { promptRetries: 0, trackedSpawnDeadlineMs: 10_000, trackedSpawnStartupDeadlineMs: 30_000 },
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
          evidenceMode: "current" as const,
        },
        review: {
          enabled: true,
          resolver: { type: "majority-fail-closed" as const },
          sessionMode: "one-shot" as const,
          rounds: 2,
          mode: "panel" as const,
          timeoutSeconds: 600,
          autoPersona: false,
          evidenceMode: undefined,
        },
        acceptance: {
          enabled: false,
          resolver: { type: "majority-fail-closed" as const },
          sessionMode: "one-shot" as const,
          rounds: 1,
          mode: "panel" as const,
          timeoutSeconds: 600,
          autoPersona: false,
          evidenceMode: undefined,
        },
        rectification: {
          enabled: false,
          resolver: { type: "synthesis" as const },
          sessionMode: "one-shot" as const,
          rounds: 1,
          mode: "panel" as const,
          timeoutSeconds: 600,
          autoPersona: false,
          evidenceMode: undefined,
        },
        escalation: {
          enabled: false,
          resolver: { type: "majority-fail-closed" as const },
          sessionMode: "one-shot" as const,
          rounds: 1,
          mode: "panel" as const,
          timeoutSeconds: 600,
          autoPersona: false,
          evidenceMode: undefined,
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
        enabled: z.boolean().default(false),
        /**
         * Whether the phase spends an agent turn writing the PR body's
         * "What changed" section. Disabled -> the body carries the
         * mechanical fallback (spec Summary) or no such section at all.
         */
        narrative: z.boolean().default(true),
        /**
         * How the repo's own PR/MR template is honoured.
         *
         * `merge` (default) treats the template as shape: headings the body
         * can fill keep their wording, headings it cannot are dropped, and
         * content with no matching heading is appended under nax's own.
         * `strict` keeps the unfillable headings, empty, for repos whose CI
         * asserts a set of headings exists. `ignore` skips the template.
         *
         * Never appends the template verbatim -- that shipped an unfilled
         * form below a filled one (#1504).
         */
        prBody: z
          .object({
            template: z.enum(["merge", "strict", "ignore"]).default("merge"),
            /**
             * Template heading -> body-section key, layered over the defaults
             * in `src/forge/template-merge.ts`. Matched case- and
             * punctuation-insensitively; an empty value suppresses a default
             * alias. Known keys: `narrative`, `stories`, `verification`,
             * `rounds`, `outOfScope`.
             */
            sectionMap: z.record(z.string(), z.string()).default({}),
          })
          .default({ template: "merge", sectionMap: {} }),
        /**
         * Per-step model selection, resolved by `resolveConfiguredModel` the
         * same way every other operation's is. null falls through to
         * `callOp`'s own default ("balanced").
         */
        reviewers: z
          .object({
            spec: ConfiguredModelSchema.nullable().default(null),
            quality: ConfiguredModelSchema.nullable().default(null),
            narrative: ConfiguredModelSchema.nullable().default(null),
            fix: ConfiguredModelSchema.nullable().default(null),
          })
          .default({ spec: null, quality: null, narrative: null, fix: null }),
        escalate: z.object({ telegram: z.boolean().default(true) }).default({ telegram: true }),
        notify: z
          .object({ mode: z.enum(["escalation", "always", "off"]).default("escalation") })
          .default({ mode: "escalation" }),
        /**
         * Cross-run idempotency (#1674 part 1). `on-change` (default) skips
         * the phase entirely when the ledger's `branch`/`headSha` match the
         * current branch/HEAD and the recorded status is terminal — a
         * re-run at the same commit can only repeat side effects, never do
         * new work. `always` bypasses the ledger, matching pre-ledger
         * behaviour, for repos that want every run to redrive finish.
         */
        rerun: z.enum(["on-change", "always"]).default("on-change"),
        // Wall-clock caps. Every one bounds work the phase awaits; without
        // them a hung gate stalls the run's completion phase, which has no
        // timeout of its own.
        timeouts: z
          .object({
            /** Per acceptance-test group. */
            acceptanceMs: z.number().int().positive().default(600_000),
            /** Per quality gate (build / typecheck / lint / test). */
            gateMs: z.number().int().positive().default(900_000),
            /** Whole-phase deadline, enforced as an AbortSignal (design 4.7). */
            flowMs: z.number().int().positive().default(5_400_000),
            /** Per LLM op (one review, fix or narrative turn). null keeps callOp's own default. */
            stepMs: z.number().int().positive().nullable().default(null),
          })
          .default({ acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null }),
      })
      .default({
        enabled: false,
        narrative: true,
        prBody: { template: "merge", sectionMap: {} },
        reviewers: { spec: null, quality: null, narrative: null, fix: null },
        escalate: { telegram: true },
        notify: { mode: "escalation" },
        rerun: "on-change",
        timeouts: { acceptanceMs: 600_000, gateMs: 900_000, flowMs: 5_400_000, stepMs: null },
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
