/**
 * TDD-strategy-specific types.
 *
 * Wrapper-level types (TddSessionRole, FailureCategory, IsolationCheck,
 * TddSessionResult) are re-exported from src/execution/types — the canonical
 * owner is the wrapper layer (US-005 §5).
 */

import type { TokenUsage } from "../agents/cost";
import type { TddSessionResult } from "../execution/types";

export type {
  FailureCategory,
  IsolationCheck,
  TddSessionResult,
  TddSessionRole,
} from "../execution/types";

/** Options for three-session TDD. Strategy-specific — stays in src/tdd. */
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
  getTddContextBundle?: (
    role: import("../execution/types").TddSessionRole,
  ) => Promise<import("../context/engine").ContextBundle | undefined>;
  /** Persist per-session outcomes (scratch, digests, metrics) as soon as they exist. */
  recordTddSessionOutcome?: (result: TddSessionResult) => Promise<void>;
  /**
   * #541: Bind a TDD session's ACP protocolIds to a pre-created session descriptor.
   * Returns `{ sessionManager, sessionId }` when the orchestrator has a descriptor
   * for this role; undefined when no sessionManager is configured.
   */
  getTddSessionBinding?: (
    role: import("../execution/types").TddSessionRole,
  ) => import("./session-runner").TddSessionBinding | undefined;
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
  runtime: import("../runtime").NaxRuntime;
}

/**
 * Sum TokenUsage values across TDD session results (#590).
 * Returns undefined when no session reported usage — mirrors the adapter
 * contract so `metrics.tracker` can emit a tokens block only when real data exists.
 */
export function sumTddTokenUsage(sessions: TddSessionResult[]): TokenUsage | undefined {
  const usages = sessions.map((s) => s.tokenUsage).filter((u): u is TokenUsage => !!u);
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
