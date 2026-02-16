/**
 * Configuration Schema
 *
 * Global (~/.ngent/config.json) + Project (ngent/config.json)
 */

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

/** Per-tier model definition */
export interface ModelDef {
  /** Provider name (e.g., "anthropic", "openai", "ollama") */
  provider: string;
  /** Model identifier (e.g., "claude-sonnet-4-5", "gpt-5-mini") */
  model: string;
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

/** Full ngent configuration */
export interface NgentConfig {
  /** Schema version */
  version: 1;
  /** Model mapping — abstract tiers to actual model identifiers */
  models: ModelMap;
  /** Auto mode / routing config */
  autoMode: AutoModeConfig;
  /** Execution limits */
  execution: ExecutionConfig;
  /** Quality gates */
  quality: QualityConfig;
  /** TDD settings */
  tdd: TddConfig;
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
    },
  },
  execution: {
    maxIterations: 20,
    iterationDelayMs: 2000,
    costLimit: 5.0,
    sessionTimeoutSeconds: 600, // 10 minutes
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
};
