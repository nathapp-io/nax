/**
 * Debate Feature Types
 *
 * Type definitions for the multi-agent debate system.
 */

import type { ConfiguredModel } from "@/config/schema-types";

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
  /** Optional model override — defaults to the "fast" tier when absent */
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

/** Configuration for the grounder pre-phase */
export interface GrounderConfig {
  model: ConfiguredModel;
  timeoutSeconds: number;
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
  mode?: DebateMode;
  /** Number of debate rounds */
  rounds: number;
  /** Optional debaters array — defaults to resolveDefaultAgent(config) for each entry when absent (min 2 entries) */
  debaters?: Debater[];
  /** Timeout for debate session in seconds (default: 600) */
  timeoutSeconds?: number;
  /** When true, auto-assign personas to debaters that have no explicit persona. Default: false. */
  autoPersona?: boolean;
  /** Optional pre-debate phase to run before proposers */
  preDebatePhase?: { kind: "grounder" | "custom"; onFailure?: "degrade" | "block" };
  /** Optional proposer constraints */
  proposers?: {
    citationsRequired?: boolean;
    fileReadAccess?: boolean;
    fileReadBudget?: number;
  };
  /** Optional selector strategy override */
  selector?:
    | { kind: "synthesis" }
    | { kind: "majority-fail-closed" }
    | { kind: "majority-fail-open" }
    | { kind: "judge" }
    | {
        kind: "verifier-pick";
        patch?: {
          enabled: boolean;
          overlapThreshold?: number;
          maxDeltas?: number;
          onFailure?: "use-unpatched" | "block";
        };
      };
  /** Optional post-debate verifier */
  postDebateVerifier?: {
    kind: "plan-checklist" | "custom";
    onBlocker?: "block" | "tag-expert";
  };
  /** Evidence mode for plan stage only (Phase 2) */
  evidenceMode?: "current" | "asymmetric";
}

/** Top-level debate configuration */
export interface DebateConfig {
  /** Enable multi-agent debate globally */
  enabled: boolean;
  /** Grounder pre-phase configuration (defaulted by Zod, always present after parse) */
  grounder: GrounderConfig;
  /** Default number of debating agents when no explicit debaters array is specified */
  agents: number;
  /** Maximum number of debaters running concurrently per debate round (default: 2) */
  maxConcurrentDebaters: number;
  /** Per-stage debate configuration */
  stages: {
    /** Planning phase debate */
    plan: DebateStageConfig;
    /** Acceptance test phase debate */
    acceptance: DebateStageConfig;
    /** Rectification loop debate */
    rectification: DebateStageConfig;
    /** Escalation phase debate */
    escalation: DebateStageConfig;
    /** Decompose phase debate (optional, for plan-decompose) */
    decompose?: DebateStageConfig;
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
