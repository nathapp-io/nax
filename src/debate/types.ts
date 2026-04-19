/**
 * Debate Feature Types
 *
 * Type definitions for the multi-agent debate system.
 */

/** How the resolver determines the outcome of a debate round */
export type ResolverType = "synthesis" | "majority-fail-closed" | "majority-fail-open" | "custom";

/** How agent sessions are managed across debate rounds */
export type SessionMode = "one-shot" | "stateful";

/** Debate execution mode */
export type DebateMode = "panel" | "hybrid";

/** Analytical lens assigned to a debater to ensure differentiated perspectives */
export type DebaterPersona = "challenger" | "pragmatist" | "completionist" | "security" | "testability";

/** A single debater agent in a debate */
export interface Debater {
  /** Agent name (e.g. 'claude', 'opencode') */
  agent: string;
  /** Optional model override — resolved from config.models.fast at runtime when absent */
  model?: string;
  /** Optional analytical persona — injected as a ## Your Role block in the prompt */
  persona?: DebaterPersona;
}

/** Resolver configuration for a debate stage */
export interface ResolverConfig {
  /** Strategy for resolving debate outcome */
  type: ResolverType;
  /** Optional agent to use as resolver (defaults to resolveDefaultAgent(config) when absent) */
  agent?: string;
  /** Model override for the resolver agent — accepts tier labels ("fast"|"balanced"|"powerful"),
   *  shorthand aliases ("haiku"|"sonnet"|"opus"), or a full model ID. Defaults to "fast" when absent. */
  model?: string;
  /** Tie-breaker strategy when votes are tied */
  tieBreaker?: string;
  /** Max prompt tokens passed to the resolver agent */
  maxPromptTokens?: number;
}

/** Per-stage debate configuration */
export interface DebateStageConfig {
  /** Enable debate for this stage */
  enabled: boolean;
  /** Resolver configuration */
  resolver: ResolverConfig;
  /** Session mode for debater agents */
  sessionMode: SessionMode;
  /** Debate execution mode */
  mode: DebateMode;
  /** Number of debate rounds */
  rounds: number;
  /** Optional debaters array — defaults to resolveDefaultAgent(config) for each entry when absent (min 2 entries) */
  debaters?: Debater[];
  /** Timeout for debate session in seconds (default: 600) */
  timeoutSeconds: number;
  /** When true, auto-assign personas to debaters that have no explicit persona. Default: false. */
  autoPersona?: boolean;
}

/** Top-level debate configuration */
export interface DebateConfig {
  /** Enable multi-agent debate globally */
  enabled: boolean;
  /** Default number of debating agents when no explicit debaters array is specified */
  agents: number;
  /** Maximum number of debaters running concurrently per debate round (default: 2) */
  maxConcurrentDebaters: number;
  /** Per-stage debate configuration */
  stages: {
    /** Planning phase debate */
    plan: DebateStageConfig;
    /** Review phase debate */
    review: DebateStageConfig;
    /** Acceptance test phase debate */
    acceptance: DebateStageConfig;
    /** Rectification loop debate */
    rectification: DebateStageConfig;
    /** Escalation phase debate */
    escalation: DebateStageConfig;
  };
}

/** Context passed to resolveDebate() — varies by resolver type */
export interface DebateResolverContext {
  resolverType: ResolverType;
  /** For majority resolvers: the raw vote tally (computed before resolveDebate is called) */
  majorityVote?: { passed: boolean; passCount: number; failCount: number };
}

/** A single debater's rebuttal in a debate round */
export interface Rebuttal {
  /** Debater identity */
  debater: Debater;
  /** Round number this rebuttal was produced in */
  round: number;
  /** Output from the debater's rebuttal */
  output: string;
}

/** A single debater's proposal output */
export interface Proposal {
  /** Debater identity */
  debater: Debater;
  /** Output from the debater's complete() call */
  output: string;
}

/** Result of a completed debate session */
export interface DebateResult {
  /** Story identifier */
  storyId: string;
  /** Pipeline stage the debate ran in */
  stage: string;
  /** Debate outcome */
  outcome: "passed" | "failed" | "skipped";
  /** Number of rounds completed */
  rounds: number;
  /** Agents that participated as debaters */
  debaters: string[];
  /** Resolver strategy used */
  resolverType: ResolverType;
  /** Per-debater proposals with identity and output */
  proposals: Proposal[];
  /** Total cost across all complete() calls (USD) */
  totalCostUsd: number;
  /** Optional human-readable summary from the resolver */
  summary?: string;
  /** Resolved output text from the debate (populated by the resolver; used as rawResponse in plan/review) */
  output?: string;
  /** Per-debater rebuttals across rounds */
  rebuttals?: Rebuttal[];
}
