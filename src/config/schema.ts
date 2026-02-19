/**
 * Configuration Schema
 *
 * Global (~/.nax/config.json) + Project (nax/config.json)
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

/** Model tier names — extensible (supports custom tiers like "ultra", "free") */
export type ModelTier = string;

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
  /** Model identifier (e.g., "sonnet", "gpt-5-mini") */
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

/** Per-tier attempt configuration for escalation */
export interface TierConfig {
  /** Tier name (e.g., "fast", "balanced", "powerful") */
  tier: string;
  /** Number of attempts at this tier before escalating */
  attempts: number;
}

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
    /** Ordered tier escalation with per-tier attempt budgets */
    tierOrder: TierConfig[];
    /** When a batch fails, escalate all stories in the batch (default: true) */
    escalateEntireBatch?: boolean;
  };
}

/** Execution limits */
export interface ExecutionConfig {
  /** Max iterations per feature run (auto-calculated from tierOrder sum if not set) */
  maxIterations: number;
  /** Delay between iterations (ms) */
  iterationDelayMs: number;
  /** Max cost (USD) before pausing */
  costLimit: number;
  /** Timeout per agent coding session (seconds) */
  sessionTimeoutSeconds: number;
  /** Verification subprocess timeout in seconds (ADR-003 Decision 4) */
  verificationTimeoutSeconds: number;
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
  /** Append --forceExit to test command to prevent open handle hangs (default: false) */
  forceExit: boolean;
  /** Append --detectOpenHandles on timeout retry to diagnose hangs (default: true) */
  detectOpenHandles: boolean;
  /** Max retries with --detectOpenHandles before falling back to --forceExit (default: 1) */
  detectOpenHandlesRetries: number;
  /** Grace period in ms after SIGTERM before sending SIGKILL (default: 5000) */
  gracePeriodMs: number;
  /** Deadline in ms to drain stdout/stderr after killing process (Bun stream workaround, default: 2000) */
  drainTimeoutMs: number;
  /** Shell to use for running verification commands (default: /bin/sh) */
  shell: string;
  /** Environment variables to strip during verification (prevents AI-optimized output) */
  stripEnvVars: string[];
  /** Divisor for environmental failure early escalation (default: 2 = half the tier budget) */
  environmentalEscalationDivisor: number;
}

/** TDD config */
export interface TddConfig {
  /** Max retries for each session before escalating */
  maxRetries: number;
  /** Auto-verify isolation between sessions */
  autoVerifyIsolation: boolean;
  /** Session 3 verifier: auto-approve legitimate fixes */
  autoApproveVerifier: boolean;
  /** Per-session model tier overrides. Defaults: test-writer=balanced, implementer=story tier, verifier=fast */
  sessionTiers?: {
    /** Model tier for test-writer session (default: "balanced") */
    testWriter?: ModelTier;
    /** Model tier for implementer session (default: uses story's routed tier) */
    implementer?: ModelTier;
    /** Model tier for verifier session (default: "fast") */
    verifier?: ModelTier;
  };
}

/** Constitution config */
export interface ConstitutionConfig {
  /** Enable constitution loading and injection */
  enabled: boolean;
  /** Path to constitution file relative to nax/ directory */
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
  /** Output path for generated spec (relative to nax/ directory) */
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

/** Test coverage context config */
export interface TestCoverageConfig {
  /** Enable test coverage context injection (default: true) */
  enabled: boolean;
  /** Detail level for test summary */
  detail: "names-only" | "names-and-counts" | "describe-blocks";
  /** Max tokens for the summary (default: 500) */
  maxTokens: number;
  /** Test directory relative to workdir (default: auto-detect) */
  testDir?: string;
  /** Glob pattern for test files */
  testPattern: string;
}

/** Context config */
export interface ContextConfig {
  /** Test coverage summary injection */
  testCoverage: TestCoverageConfig;
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

/** LLM routing config */
export interface LlmRoutingConfig {
  /** Model tier for routing call (default: "fast") */
  model?: string;
  /** Fall back to keyword strategy on LLM failure (default: true) */
  fallbackToKeywords?: boolean;
  /** Max input tokens for story context (default: 2000) */
  maxInputTokens?: number;
  /** Cache routing decisions per story ID (default: true) */
  cacheDecisions?: boolean;
  /** Batch mode: route multiple stories in one LLM call (default: true) */
  batchMode?: boolean;
  /** Timeout for LLM call in milliseconds (default: 15000) */
  timeoutMs?: number;
}

/** Routing config */
export interface RoutingConfig {
  /** Strategy to use (default: "keyword") */
  strategy: RoutingStrategyName;
  /** Path to custom strategy file (required if strategy = "custom") */
  customStrategyPath?: string;
  /** Adaptive routing settings (used when strategy = "adaptive") */
  adaptive?: AdaptiveRoutingConfig;
  /** LLM routing settings (used when strategy = "llm") */
  llm?: LlmRoutingConfig;
}

/** Full nax configuration */
export interface NaxConfig {
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
  /** Context injection settings */
  context: ContextConfig;
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

const ModelTierSchema = z.string().min(1, "Tier name must be non-empty");

const TierConfigSchema = z.object({
  tier: z.string().min(1, "Tier name must be non-empty"),
  attempts: z.number().int().min(1).max(20, { message: "attempts must be 1-20" }),
});

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
    tierOrder: z.array(TierConfigSchema).min(1, { message: "tierOrder must have at least one tier" }),
    escalateEntireBatch: z.boolean().optional(),
  }),
});

const ExecutionConfigSchema = z.object({
  maxIterations: z.number().int().positive({ message: "maxIterations must be > 0" }),
  iterationDelayMs: z.number().int().nonnegative(),
  costLimit: z.number().positive({ message: "costLimit must be > 0" }),
  sessionTimeoutSeconds: z.number().int().positive({ message: "sessionTimeoutSeconds must be > 0" }),
  verificationTimeoutSeconds: z.number().int().min(1).max(3600).default(300),
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
  sessionTiers: z.object({
    testWriter: z.string().optional(),
    implementer: z.string().optional(),
    verifier: z.string().optional(),
  }).optional(),
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

const TestCoverageConfigSchema = z.object({
  enabled: z.boolean().default(true),
  detail: z.enum(["names-only", "names-and-counts", "describe-blocks"]).default("names-and-counts"),
  maxTokens: z.number().int().min(50).max(5000).default(500),
  testDir: z.string().optional(),
  testPattern: z.string().default("**/*.test.{ts,js,tsx,jsx}"),
});

const ContextConfigSchema = z.object({
  testCoverage: TestCoverageConfigSchema,
});

const AdaptiveRoutingConfigSchema = z.object({
  minSamples: z.number().int().positive({ message: "adaptive.minSamples must be > 0" }),
  costThreshold: z.number().min(0).max(1, { message: "adaptive.costThreshold must be 0-1" }),
  fallbackStrategy: z.enum(["keyword", "llm", "manual"]),
});

const LlmRoutingConfigSchema = z.object({
  model: z.string().optional(),
  fallbackToKeywords: z.boolean().optional(),
  maxInputTokens: z.number().int().positive({ message: "llm.maxInputTokens must be > 0" }).optional(),
  cacheDecisions: z.boolean().optional(),
  batchMode: z.boolean().optional(),
  timeoutMs: z.number().int().positive({ message: "llm.timeoutMs must be > 0" }).optional(),
});

const RoutingConfigSchema = z.object({
  strategy: z.enum(["keyword", "llm", "manual", "adaptive", "custom"]),
  customStrategyPath: z.string().optional(),
  adaptive: AdaptiveRoutingConfigSchema.optional(),
  llm: LlmRoutingConfigSchema.optional(),
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
  })
  .refine((data) => data.version === 1, {
    message: "Invalid version: expected 1",
    path: ["version"],
  });

/** Default configuration */
export const DEFAULT_CONFIG: NaxConfig = {
  version: 1,
  models: {
    fast: { provider: "anthropic", model: "haiku" },
    balanced: { provider: "anthropic", model: "sonnet" },
    powerful: { provider: "anthropic", model: "opus" },
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
      tierOrder: [
        { tier: "fast", attempts: 5 },
        { tier: "balanced", attempts: 3 },
        { tier: "powerful", attempts: 2 },
      ],
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
    llm: {
      model: "fast",
      fallbackToKeywords: true,
      maxInputTokens: 2000,
      cacheDecisions: true,
      batchMode: true,
      timeoutMs: 15000,
    },
  },
  execution: {
    maxIterations: 10, // auto-calculated: sum of tier attempts (5+3+2=10)
    iterationDelayMs: 2000,
    costLimit: 5.0,
    sessionTimeoutSeconds: 600, // 10 minutes
    verificationTimeoutSeconds: 300, // 5 minutes
    maxStoriesPerFeature: 500,
  },
  quality: {
    requireTypecheck: true,
    requireLint: true,
    requireTests: true,
    commands: {},
    forceExit: false,
    detectOpenHandles: true,
    detectOpenHandlesRetries: 1,
    gracePeriodMs: 5000,
    drainTimeoutMs: 2000,
    shell: "/bin/sh",
    stripEnvVars: ["CLAUDECODE", "REPL_ID", "AGENT"],
    environmentalEscalationDivisor: 2,
  },
  tdd: {
    maxRetries: 2,
    autoVerifyIsolation: true,
    autoApproveVerifier: true,
    sessionTiers: {
      testWriter: "balanced",
      // implementer: undefined = uses story's routed tier
      verifier: "fast",
    },
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
  context: {
    testCoverage: {
      enabled: true,
      detail: "names-and-counts",
      maxTokens: 500,
      testPattern: "**/*.test.{ts,js,tsx,jsx}",
    },
  },
};

