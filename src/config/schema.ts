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

/** Auto mode configuration */
export interface AutoModeConfig {
  enabled: boolean;
  /** Default agent to use */
  defaultAgent: string;
  /** Fallback order when agent is rate-limited */
  fallbackOrder: string[];
  /** Model tier per complexity */
  complexityRouting: Record<Complexity, string>;
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
  /** Auto mode / routing config */
  autoMode: AutoModeConfig;
  /** Execution limits */
  execution: ExecutionConfig;
  /** Quality gates */
  quality: QualityConfig;
  /** TDD settings */
  tdd: TddConfig;
}

/** Default configuration */
export const DEFAULT_CONFIG: NgentConfig = {
  version: 1,
  autoMode: {
    enabled: true,
    defaultAgent: "claude",
    fallbackOrder: ["claude", "codex", "opencode", "gemini"],
    complexityRouting: {
      simple: "cheap",
      medium: "standard",
      complex: "premium",
      expert: "premium",
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
