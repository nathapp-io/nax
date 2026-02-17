/**
 * Configuration Schema
 *
 * Global (~/.ngent/config.json) + Project (ngent/config.json)
 */

import { z } from "zod";

/** Complexity classification */
export type Complexity = "simple" | "medium" | "complex" | "expert";

/** Test strategy */
export type TestStrategy = "test-after" | "three-session-tdd";

/** Escalation path entry */
export interface EscalationEntry {
  from: string;
  to: string;
}

/** Model tier names */
export type ModelTier = "fast" | "balanced" | "powerful";

/** Per-tier token pricing (USD per 1M tokens) */
export interface TokenPricing {
  /** Cost per 1M input tokens */
  inputPer1M: number;
  /** Cost per 1M output tokens */
  outputPer1M: number;
}

/** Per-tier model definition */
export interface ModelDef {
  /** Provider name (e.g., "anthropic", "openai", "ollama") */
  provider: string;
  /** Model identifier (e.g., "claude-sonnet-4-5", "gpt-5-mini") */
  model: string;
  /** Optional token pricing override (defaults to built-in rates) */
  pricing?: TokenPricing;
  /** Environment variable overrides passed to the agent process */
  env?: Record<string, string>;
}

/** Shorthand: either a full ModelDef or just a model string */
export type ModelEntry = ModelDef | string;

/** Model mapping — maps abstract tiers to model definitions */
export type ModelMap = Record<ModelTier, ModelEntry>;

/** Auto mode configuration */
export interface AutoModeConfig {
  enabled: boolean;
  /** Default agent to use */
  defaultAgent: string;
  /** Fallback order when agent is rate-limited */
  fallbackOrder: string[];
  /** Model tier per complexity */
  complexityRouting: Record<Complexity, ModelTier>;
  /** Escalation config */
  escalation: {
    enabled: boolean;
    maxAttempts: number;
    /** Escalation tier order (default: ["fast", "balanced", "powerful"]) */
    tierOrder?: ModelTier[];
    /** When a batch fails, escalate all stories in the batch (default: true) */
    escalateEntireBatch?: boolean;
  };
}

/** Execution limits */
export interface ExecutionConfig {
  /** Max iterations per feature run */
  maxIterations: number;
  /** Delay between iterations (ms) */
  iterationDelayMs: number;
  /** Max cost (USD) before pausing */
  costLimit: number;
  /** Timeout per agent session (seconds) */
  sessionTimeoutSeconds: number;
  /** Max stories per feature (prevents memory exhaustion) */
  maxStoriesPerFeature: number;
}

/** Quality gate config */
export interface QualityConfig {
  /** Require typecheck to pass */
  requireTypecheck: boolean;
  /** Require lint to pass */
  requireLint: boolean;
  /** Require tests to pass */
  requireTests: boolean;
  /** Custom quality commands */
  commands: {
    typecheck?: string;
    lint?: string;
    test?: string;
  };
}

/** TDD config */
export interface TddConfig {
  /** Max retries for each session before escalating */
  maxRetries: number;
  /** Auto-verify isolation between sessions */
  autoVerifyIsolation: boolean;
  /** Session 3 verifier: auto-approve legitimate fixes */
  autoApproveVerifier: boolean;
}

/** Constitution config */
export interface ConstitutionConfig {
  /** Enable constitution loading and injection */
  enabled: boolean;
  /** Path to constitution file relative to ngent/ directory */
  path: string;
  /** Maximum tokens allowed for constitution content */
  maxTokens: number;
}

/** Analyze config */
export interface AnalyzeConfig {
  /** Enable LLM-enhanced analysis */
  llmEnhanced: boolean;
  /** Model tier for decompose+classify (default: balanced) */
  model: ModelTier;
  /** Fall back to keyword matching on LLM failure */
  fallbackToKeywords: boolean;
  /** Max tokens for codebase summary */
  maxCodebaseSummaryTokens: number;
}

/** Review config */
export interface ReviewConfig {
  /** Enable review phase */
  enabled: boolean;
  /** List of checks to run */
  checks: Array<"typecheck" | "lint" | "test">;
  /** Custom commands per check */
  commands: {
    typecheck?: string;
    lint?: string;
    test?: string;
  };
}

/** Plan config */
export interface PlanConfig {
  /** Model tier for planning (default: balanced) */
  model: ModelTier;
  /** Output path for generated spec (relative to ngent/ directory) */
  outputPath: string;
}

/** Acceptance validation config */
export interface AcceptanceConfig {
  /** Enable acceptance test generation and validation */
  enabled: boolean;
  /** Maximum retry loops for fix stories (default: 2) */
  maxRetries: number;
  /** Generate acceptance tests during analyze (default: true) */
  generateTests: boolean;
  /** Path to acceptance test file (relative to feature directory) */
  testPath: string;
}

/** Routing strategy name */
export type RoutingStrategyName = "keyword" | "llm" | "manual" | "adaptive" | "custom";

/** Adaptive routing config */
export interface AdaptiveRoutingConfig {
  /** Minimum samples needed before adaptive routing kicks in (default: 10) */
  minSamples: number;
  /** Cost threshold for switching tiers (0-1, default: 0.8) */
  costThreshold: number;
  /** Fallback strategy when insufficient data (default: "llm") */
  fallbackStrategy: "keyword" | "llm" | "manual";
}

/** Routing config */
export interface RoutingConfig {
  /** Strategy to use (default: "keyword") */
  strategy: RoutingStrategyName;
  /** Path to custom strategy file (required if strategy = "custom") */
  customStrategyPath?: string;
  /** Adaptive routing settings (used when strategy = "adaptive") */
  adaptive?: AdaptiveRoutingConfig;
}

/** Full ngent configuration */
export interface NgentConfig {
  /** Schema version */
  version: 1;
  /** Model mapping — abstract tiers to actual model identifiers */
  models: ModelMap;
  /** Auto mode / routing config */
  autoMode: AutoModeConfig;
  /** Routing strategy config */
  routing: RoutingConfig;
  /** Execution limits */
  execution: ExecutionConfig;
  /** Quality gates */
  quality: QualityConfig;
  /** TDD settings */
  tdd: TddConfig;
  /** Constitution settings */
  constitution: ConstitutionConfig;
  /** Analyze settings */
  analyze: AnalyzeConfig;
  /** Review settings */
  review: ReviewConfig;
  /** Plan settings */
  plan: PlanConfig;
  /** Acceptance validation settings */
  acceptance: AcceptanceConfig;
}

/** Resolve a ModelEntry (string shorthand or full object) into a ModelDef */
export function resolveModel(entry: ModelEntry): ModelDef {
  if (typeof entry === "string") {
    // Infer provider from model name
    const provider = entry.startsWith("claude")
      ? "anthropic"
      : entry.startsWith("gpt") || entry.startsWith("o1") || entry.startsWith("o3")
        ? "openai"
        : entry.startsWith("gemini")
          ? "google"
          : "unknown";
    return { provider, model: entry };
  }
  return entry;
}

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

const ModelEntrySchema = z.union([
  z.string().min(1, "Model identifier must be non-empty"),
  ModelDefSchema,
]);

const ModelMapSchema = z.object({
  fast: ModelEntrySchema,
  balanced: ModelEntrySchema,
  powerful: ModelEntrySchema,
});

const ModelTierSchema = z.enum(["fast", "balanced", "powerful"]);

const AutoModeConfigSchema = z.object({
  enabled: z.boolean(),
  defaultAgent: z
    .string()
    .trim()
    .min(1, "defaultAgent must be non-empty"),
  fallbackOrder: z.array(z.string()),
  complexityRouting: z.object({
    simple: ModelTierSchema,
    medium: ModelTierSchema,
    complex: ModelTierSchema,
    expert: ModelTierSchema,
  }),
  escalation: z.object({
    enabled: z.boolean(),
    maxAttempts: z.number().int().positive({ message: "escalation.maxAttempts must be > 0" }),
    tierOrder: z.array(ModelTierSchema).optional(),
    escalateEntireBatch: z.boolean().optional(),
  }),
});

const ExecutionConfigSchema = z.object({
  maxIterations: z.number().int().positive({ message: "maxIterations must be > 0" }),
  iterationDelayMs: z.number().int().nonnegative(),
  costLimit: z.number().positive({ message: "costLimit must be > 0" }),
  sessionTimeoutSeconds: z.number().int().positive({ message: "sessionTimeoutSeconds must be > 0" }),
  maxStoriesPerFeature: z.number().int().positive(),
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
});

const TddConfigSchema = z.object({
  maxRetries: z.number().int().nonnegative(),
  autoVerifyIsolation: z.boolean(),
  autoApproveVerifier: z.boolean(),
});

const ConstitutionConfigSchema = z.object({
  enabled: z.boolean(),
  path: z.string().min(1, "constitution.path must be non-empty"),
  maxTokens: z.number().int().positive({ message: "constitution.maxTokens must be > 0" }),
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

const AdaptiveRoutingConfigSchema = z.object({
  minSamples: z.number().int().positive({ message: "adaptive.minSamples must be > 0" }),
  costThreshold: z.number().min(0).max(1, { message: "adaptive.costThreshold must be 0-1" }),
  fallbackStrategy: z.enum(["keyword", "llm", "manual"]),
});

const RoutingConfigSchema = z.object({
  strategy: z.enum(["keyword", "llm", "manual", "adaptive", "custom"]),
  customStrategyPath: z.string().optional(),
  adaptive: AdaptiveRoutingConfigSchema.optional(),
}).refine(
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
  }
);

export const NgentConfigSchema = z
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
  })
  .refine((data) => data.version === 1, {
    message: "Invalid version: expected 1",
    path: ["version"],
  });

/** Default configuration */
export const DEFAULT_CONFIG: NgentConfig = {
  version: 1,
  models: {
    fast: { provider: "anthropic", model: "claude-haiku-4-5" },
    balanced: { provider: "anthropic", model: "claude-sonnet-4-5" },
    powerful: { provider: "anthropic", model: "claude-opus-4" },
  },
  autoMode: {
    enabled: true,
    defaultAgent: "claude",
    fallbackOrder: ["claude", "codex", "opencode", "gemini"],
    complexityRouting: {
      simple: "fast",
      medium: "balanced",
      complex: "powerful",
      expert: "powerful",
    },
    escalation: {
      enabled: true,
      maxAttempts: 3,
      tierOrder: ["fast", "balanced", "powerful"],
      escalateEntireBatch: true,
    },
  },
  routing: {
    strategy: "keyword",
    adaptive: {
      minSamples: 10,
      costThreshold: 0.8,
      fallbackStrategy: "llm",
    },
  },
  execution: {
    maxIterations: 20,
    iterationDelayMs: 2000,
    costLimit: 5.0,
    sessionTimeoutSeconds: 600, // 10 minutes
    maxStoriesPerFeature: 500,
  },
  quality: {
    requireTypecheck: true,
    requireLint: true,
    requireTests: true,
    commands: {},
  },
  tdd: {
    maxRetries: 2,
    autoVerifyIsolation: true,
    autoApproveVerifier: true,
  },
  constitution: {
    enabled: true,
    path: "constitution.md",
    maxTokens: 2000,
  },
  analyze: {
    llmEnhanced: true,
    model: "balanced",
    fallbackToKeywords: true,
    maxCodebaseSummaryTokens: 5000,
  },
  review: {
    enabled: true,
    checks: ["typecheck", "lint", "test"],
    commands: {},
  },
  plan: {
    model: "balanced",
    outputPath: "spec.md",
  },
  acceptance: {
    enabled: true,
    maxRetries: 2,
    generateTests: true,
    testPath: "acceptance.test.ts",
  },
};

