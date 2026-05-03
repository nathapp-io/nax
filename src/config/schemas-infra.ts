/**
 * Infrastructure schemas for nax configuration: plan, acceptance, routing,
 * agent, plugins, interaction, prompts, precheck, and project profile.
 * Extracted from schemas.ts to stay within the 600-line file limit.
 */

import { z } from "zod";
import { ConfiguredModelSchema, ModelTierSchema } from "./schemas-model";

export const PlanConfigSchema = z.object({
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
  /** ADR-021 phase 8: emit findings: Finding[] in diagnose prompt instead of testIssues/sourceIssues. Default off for one release. */
  findingsV2: z.boolean().default(false),
  /** ADR-022 phase 4: use runFixCycle for acceptance retries instead of the hand-rolled loop. Default off. */
  cycleV2: z.boolean().default(false),
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
    findingsV2: false,
    cycleV2: false,
  }),
  suggestedTestPath: z.string().min(1).optional(),
  hardening: z
    .object({
      enabled: z.boolean().default(true),
    })
    .optional()
    .default({ enabled: true }),
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

export const RoutingConfigSchema = z.object({
  strategy: z.enum(["keyword", "llm"]),
  llm: LlmRoutingConfigSchema.optional(),
});

export const OptimizerConfigSchema = z.object({
  enabled: z.boolean(),
  strategy: z.enum(["rule-based", "llm", "noop"]).optional(),
});

export const PluginConfigEntrySchema = z.object({
  module: z.string().min(1, "plugin.module must be non-empty"),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().default(true),
});

export const HooksConfigSchema = z.object({
  skipGlobal: z.boolean().optional(),
  hooks: z.record(z.string(), z.unknown()),
});

export const InteractionConfigSchema = z.object({
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

const AgentFallbackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  map: z.record(z.string().min(1), z.array(z.string().min(1))).default({}),
  maxHopsPerStory: z.number().int().min(1).max(10).default(2),
  onQualityFailure: z.boolean().default(false),
  rebuildContext: z.boolean().default(true),
});

const AgentAcpConfigSchema = z.object({
  promptRetries: z.number().int().min(0).max(5).default(0),
});

export const AgentConfigSchema = z.object({
  protocol: z.literal("acp").default("acp"),
  default: z.string().trim().min(1, "agent.default must be non-empty").default("claude"),
  maxInteractionTurns: z.number().int().min(1).max(100).default(20),
  promptAudit: PromptAuditConfigSchema.default({ enabled: false }),
  fallback: AgentFallbackConfigSchema.default({
    enabled: false,
    map: {},
    maxHopsPerStory: 2,
    onQualityFailure: false,
    rebuildContext: true,
  }),
  acp: AgentAcpConfigSchema.default({ promptRetries: 0 }),
});

export const PrecheckConfigSchema = z.object({
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

export const ProjectProfileSchema = z.object({
  language: z.enum(["typescript", "javascript", "go", "rust", "python", "ruby", "java", "kotlin", "php"]).optional(),
  type: z.string().optional(),
  testFramework: z.string().optional(),
  lintTool: z.string().optional(),
});

export const VALID_AGENT_TYPES = ["claude", "codex", "opencode", "cursor", "windsurf", "aider", "gemini"] as const;

export const GenerateConfigSchema = z.object({
  agents: z.array(z.enum(VALID_AGENT_TYPES)).optional(),
});

// Re-export ModelTierSchema for consumers that currently import it from schemas-infra
export { ModelTierSchema };
