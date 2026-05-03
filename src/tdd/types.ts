/** TDD session role */
export type TddSessionRole = "test-writer" | "implementer" | "verifier";

/** Failure categories for TDD orchestrator results */
export type FailureCategory =
  /** Test-writer violated file isolation or created no test files */
  | "isolation-violation"
  /** A session crashed, timed out, or the agent failed to produce usable output */
  | "session-failure"
  /** Tests were written and implemented but still fail after all sessions */
  | "tests-failing"
  /** Verifier explicitly rejected the implementation */
  | "verifier-rejected"
  /** Greenfield project with no test files — TDD not applicable (BUG-010) */
  | "greenfield-no-tests"
  /** Worktree dependency preparation failed before pipeline execution started */
  | "dependency-prep"
  | "runtime-crash";

/** Isolation verification result */
export interface IsolationCheck {
  /** Whether isolation passed (no hard violations) */
  passed: boolean;
  /** Hard violation files (files that must not be modified) */
  violations: string[];
  /** Soft violation files (allowed-path overrides, warning only) */
  softViolations?: string[];
  /** Warning files (e.g., implementer touching test files slightly) */
  warnings?: string[];
  /** Human-readable description of what was checked */
  description?: string;
}

/** Result of a single TDD session */
export interface TddSessionResult {
  /** Session role */
  role: TddSessionRole;
  /** Whether session completed successfully */
  success: boolean;
  /** Isolation check results (if applicable) */
  isolation?: IsolationCheck;
  /** Cost of this session (USD) */
  estimatedCostUsd: number;
  /**
   * Token usage for this session (fixes #590).
   * Undefined when the adapter did not report usage (e.g. pre-first-turn
   * failure, or a mock adapter in tests).
   */
  tokenUsage?: import("../agents/cost").TokenUsage;
  /** Files changed by this session (from git diff) */
  filesChanged: string[];
  /** Duration of this session in milliseconds */
  durationMs: number;
  /** Git branch created/used (optional legacy field) */
  branch?: string;
  /** ISO timestamp (optional legacy field) */
  timestamp?: string;
  /** Error message (if success=false) */
  error?: string;
  /** Tail of the agent output for cross-session continuity/debugging */
  outputTail?: string;
  /** Number of tests written/passed/failed */
  tests?: {
    total: number;
    passed: number;
    failed: number;
  };
}

/** Options for three-session TDD */
export interface ThreeSessionTddOptions {
  agent: import("../agents").AgentAdapter;
  story: import("../prd").UserStory;
  config: import("../config").NaxConfig;
  workdir: string;
  modelTier: import("../config").ModelTier;
  /** Feature name — used for ACP session naming (nax-<hash>-<feature>-<story>-<role>) */
  featureName?: string;
  contextMarkdown?: string;
  /** Raw (unfiltered) feature context markdown from context engine v1 */
  featureContextMarkdown?: string;
  /**
   * Per-session v2 context bundles (context engine v2, Finding 1+2 fix).
   * When present, each session uses the bundle's pushMarkdown directly
   * (bypasses filterContextByRole in the TDD prompt builder).
   */
  tddContextBundles?: {
    testWriter?: import("../context/engine").ContextBundle;
    implementer?: import("../context/engine").ContextBundle;
    verifier?: import("../context/engine").ContextBundle;
  };
  /**
   * Lazy bundle hook used by the v2 path so each TDD session can assemble
   * after the previous one has already produced scratch/digest output.
   */
  getTddContextBundle?: (role: TddSessionRole) => Promise<import("../context/engine").ContextBundle | undefined>;
  /** Persist per-session outcomes (scratch, digests, metrics) as soon as they exist. */
  recordTddSessionOutcome?: (result: TddSessionResult) => Promise<void>;
  /**
   * #541: Bind a TDD session's ACP protocolIds to a pre-created session descriptor.
   * Returns `{ sessionManager, sessionId }` when the orchestrator has a descriptor
   * for this role; undefined when no sessionManager is configured.
   */
  getTddSessionBinding?: (role: TddSessionRole) => import("./session-runner").TddSessionBinding | undefined;
  constitution?: string;
  dryRun?: boolean;
  lite?: boolean;
  _recursionDepth?: number;
  /** Interaction chain for multi-turn Q&A during test-writer and implementer sessions */
  interactionChain?: import("../interaction/chain").InteractionChain | null;
  /** Absolute path to repo root — forwarded to agent.run() for prompt audit fast path */
  projectDir?: string;
  /** Shutdown abort signal (Issue 5) — forwarded to each agent.run call */
  abortSignal?: AbortSignal;
  /**
   * Audit-wired AgentManager from the pipeline context. All agent calls flow through
   * the middleware chain (audit, cost, cancellation).
   */
  agentManager: import("../agents/manager-types").IAgentManager;
  /** Runtime services used by rectification to emit prompt audit/cost events. */
  runtime?: import("../runtime").NaxRuntime;
}

/**
 * Sum TokenUsage values across TDD session results (#590).
 * Returns undefined when no session reported usage — mirrors the adapter
 * contract so `metrics.tracker` can emit a tokens block only when real data exists.
 */
export function sumTddTokenUsage(sessions: TddSessionResult[]): import("../agents/cost").TokenUsage | undefined {
  const usages = sessions.map((s) => s.tokenUsage).filter((u): u is import("../agents/cost").TokenUsage => !!u);
  if (usages.length === 0) return undefined;
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const u of usages) {
    total.inputTokens += u.inputTokens ?? 0;
    total.outputTokens += u.outputTokens ?? 0;
    total.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
    total.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
  }
  return {
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    ...(total.cacheReadInputTokens > 0 && { cacheReadInputTokens: total.cacheReadInputTokens }),
    ...(total.cacheCreationInputTokens > 0 && { cacheCreationInputTokens: total.cacheCreationInputTokens }),
  };
}

/** Result of a three-session TDD orchestration */
export interface ThreeSessionTddResult {
  /** Overall success */
  success: boolean;
  /** Individual session results */
  sessions: TddSessionResult[];
  /** Whether human review is needed */
  needsHumanReview: boolean;
  /** Reason for review (if any) */
  reviewReason?: string;
  /** Total cost of all sessions (USD) */
  totalCost: number;
  /** Total token usage summed across all sessions (fixes #590). Undefined when no session reported usage. */
  totalTokenUsage?: import("../agents/cost").TokenUsage;
  /** Total wall-clock duration of all sessions in milliseconds (sum of session durationMs). */
  totalDurationMs?: number;
  /** Whether lite mode was used (skips test-writer/implementer isolation) */
  lite: boolean;
  /** Category of failure (if success is false) */
  failureCategory?: FailureCategory;
  /**
   * Verifier verdict parsed from .nax-verifier-verdict.json (for logging/debugging).
   * null      = verdict file was missing or malformed (no verdict available)
   * undefined = verdict was not attempted (e.g. early-exit before session 3 ran)
   */
  verdict?: import("./verdict").VerifierVerdict | null;
  /** Whether the TDD full-suite gate passed (used by verify stage to skip redundant run, BUG-054) */
  fullSuiteGatePassed?: boolean;
}
