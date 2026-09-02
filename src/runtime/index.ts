export type {
  AdvisoryFindingSummaryEntry,
  IReviewAuditor,
  ReviewAuditDecision,
  ReviewAuditDispatch,
  ReviewAuditEntry,
} from "../review/review-audit";
export { _reviewAuditDeps, createNoOpReviewAuditor, ReviewAuditor } from "../review/review-audit";
export type { AgentMiddleware, MiddlewareContext } from "./agent-middleware";
export { MiddlewareChain } from "./agent-middleware";
export type {
  AgentCallEndedEvent,
  AgentCallStartedEvent,
  AgentMessageUpdateEvent,
  AgentProcessUpdateEvent,
  AgentStreamEvent,
  AgentStreamEventBase,
  AgentStreamListener,
  AgentThinkingUpdateEvent,
  AgentToolCallUpdateEvent,
  AgentUsageUpdateEvent,
  IAgentStreamEventBus,
} from "./agent-stream-events";
export { AgentStreamEventBus } from "./agent-stream-events";
export type {
  CostErrorEvent,
  CostEvent,
  CostScopeHandle,
  CostSnapshot,
  ICostAggregator,
} from "./cost-aggregator";
export { _costAggDeps, CostAggregator, createNoOpCostAggregator } from "./cost-aggregator";
export type { DispatchContext } from "./dispatch-context";
export type {
  CompleteDispatchEvent,
  DispatchErrorEvent,
  DispatchEvent,
  IDispatchEventBus,
  OperationCompletedEvent,
  ReviewDecisionEvent,
  SessionTurnDispatchEvent,
} from "./dispatch-events";
export { DispatchEventBus } from "./dispatch-events";
export type { ResolvedIdleWatchdogSettings, WatchdogState } from "./middleware";
export {
  _idleWatchdogDeps,
  attachAgentIdleWatchdog,
  attachAgentStreamLogging,
  resolveIdleWatchdogSettings,
} from "./middleware";
export type { MutationOutcomeSummary, MutationStorySummary } from "./mutation-summary";
export type { PackageRegistry, PackageView } from "./packages";
export { createPackageRegistry } from "./packages";
export type { ProjectIdentity } from "./paths";
export {
  claimProjectIdentity,
  curatorRollupPath,
  globalOutputDir,
  identityPath,
  projectInputDir,
  projectOutputDir,
  readProjectIdentity,
  writeProjectIdentity,
} from "./paths";
export type {
  IPromptAuditor,
  PromptAuditEntry,
  PromptAuditErrorEntry,
} from "./prompt-auditor";
export { _promptAuditorDeps, createNoOpPromptAuditor, PromptAuditor } from "./prompt-auditor";
export { formatSessionName } from "./session-name";
export type { CanonicalSessionRole, SessionRole } from "./session-role";
export { isSessionRole, KNOWN_SESSION_ROLES } from "./session-role";

import { basename, join } from "node:path";
import type { IAgentManager } from "../agents";
import type { CreateAgentManagerOpts } from "../agents/factory";
import { createAgentManager } from "../agents/factory";
import { AgentManager } from "../agents/manager";
import type { AgentFallbackRecord } from "../agents/manager-types";
import type { ConfigLoader, NaxConfig } from "../config";
import { createConfigLoader, getProjectKey } from "../config";
import { NaxError } from "../errors";
import { PidRegistry } from "../execution/pid-registry";
import type { ReviewRecurrenceStore } from "../execution/recurrence-store";
import type { Iteration, StoryFixHistory } from "../findings";
import { createStoryFixHistory } from "../findings";
import type { Logger } from "../logger";
import { getLogger } from "../logger";
import type { IReviewAuditor } from "../review/review-audit";
import { createNoOpReviewAuditor, ReviewAuditor } from "../review/review-audit";
import type { RoutingDecision } from "../routing/decision";
import type { ISessionManager } from "../session";
import { SessionManager } from "../session";
import { createQuarantineMemo, type QuarantineMemo } from "../verification/flake-triage";
import { MiddlewareChain } from "./agent-middleware";
import type { IAgentStreamEventBus } from "./agent-stream-events";
import { AgentStreamEventBus } from "./agent-stream-events";
import type { ICostAggregator } from "./cost-aggregator";
import { CostAggregator, createNoOpCostAggregator } from "./cost-aggregator";
import type { IDispatchEventBus } from "./dispatch-events";
import { DispatchEventBus } from "./dispatch-events";
import {
  attachAgentIdleWatchdog,
  attachAgentStreamLogging,
  attachAuditSubscriber,
  attachCostSubscriber,
  attachLoggingSubscriber,
  attachReviewAuditSubscriber,
  cancellationMiddleware,
} from "./middleware";
import type { MutationStorySummary } from "./mutation-summary";
import type { PackageRegistry } from "./packages";
import { createPackageRegistry } from "./packages";
import { curatorRollupPath, globalOutputDir, projectOutputDir } from "./paths";
import type { IPromptAuditor } from "./prompt-auditor";
import { createNoOpPromptAuditor, PromptAuditor } from "./prompt-auditor";
import { createSessionRunHop } from "./session-run-hop";

export interface NaxRuntime {
  readonly runId: string;
  readonly configLoader: ConfigLoader;
  readonly workdir: string;
  readonly projectDir: string;
  readonly outputDir: string;
  readonly globalDir: string;
  readonly curatorRollupPath: string; // ~/.nax/global/curator/rollup.jsonl or config override
  readonly projectKey: string;
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;
  readonly costAggregator: ICostAggregator;
  readonly promptAuditor: IPromptAuditor;
  readonly reviewAuditor: IReviewAuditor;
  readonly dispatchEvents: IDispatchEventBus;
  readonly agentStreamEvents: IAgentStreamEventBus;
  readonly packages: PackageRegistry;
  readonly pidRegistry: PidRegistry;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /** Run-scoped flaky-test quarantine memo — shared between the per-story full-suite gate and the deferred regression gate. */
  readonly quarantineMemo: QuarantineMemo;
  /** Run-scoped per-story adversarial-review round history (ADR-022 carry-forward + recurrence-demotion). Keyed by storyId. */
  readonly adversarialIterations: Map<string, Iteration[]>;
  /** Run-scoped per-story semantic-review round history. Separate map so the two reviewers' histories never mix. */
  readonly semanticIterations: Map<string, Iteration[]>;
  /** Run-scoped per-story rectification oscillation totals. */
  readonly rectificationOscillations: Map<string, number>;
  /**
   * Run-scoped cross-attempt review-finding recurrence store (#1666 Part C).
   * Keyed per (storyId, reviewer source) — see `recurrence-store.ts`. Distinct from
   * `rectificationOscillations`: that map counts within-cycle ping-pong, this one
   * counts the SAME finding from the SAME reviewer recurring across escalation
   * attempts, which the oscillation counter structurally cannot see.
   */
  readonly reviewFindingRecurrences: ReviewRecurrenceStore;
  /**
   * Run-scoped per-story agent-swap hops, keyed by storyId (ADR-012 PR-2, nax#1707).
   *
   * `AgentManager.runWithFallback` returns its hop records to `callOp`, which is the
   * only caller positioned to attribute them to a story. callOp appends them here so
   * `collectStoryMetrics` can surface the whole story's swaps — every op, not just the
   * implementer — as `StoryMetrics.fallback.hops`. Ad-hoc calls with no storyId
   * (plan, CLI) are not recorded.
   */
  readonly agentFallbacks: Map<string, AgentFallbackRecord[]>;
  /**
   * Run-scoped cumulative count of runtime-crash retries per story (BUG-070, nax#1707
   * follow-up).
   *
   * Distinct from `_runtimeCrashRetryCounts` in tier-escalation.ts, which counts
   * *consecutive* crashes and is deliberately cleared by any ordinary pipeline outcome
   * so the retry cap applies to a crash streak. This is the per-story total, and it is
   * run-scoped rather than on PipelineContext because that is rebuilt on every attempt.
   * Counts retries PERFORMED, which is one fewer than crashes seen: a crash that exceeds
   * RUNTIME_CRASH_RETRY_CAP pauses the story instead of retrying and is not tallied.
   * Read by collectStoryMetrics as StoryMetrics.runtimeCrashes — sequential path only;
   * the parallel executor builds its own StoryMetrics literals and does not read this.
   */
  readonly runtimeCrashRetries: Map<string, number>;
  /** Run-scoped per-(story, tier) fix-iteration + decline history (US-004). */
  readonly storyFixHistory: StoryFixHistory;
  /** Run-scoped per-story mutation-check results. */
  readonly mutationSummaries: Map<string, MutationStorySummary>;
  /**
   * Working trees the mutation spot-check injected a mutation into and could
   * NOT confirm reverted — they may still hold deliberately broken source.
   *
   * `autoCommitIfDirty` refuses to commit anything under one of these. The
   * spot-check is advisory and never fails a story, but "advisory" cannot mean
   * letting an injected defect into a commit (and, with autoPR, a push).
   *
   * Deliberately in-memory and run-scoped rather than read back off the on-disk
   * journal: a stale journal a sweep failed to reach would otherwise block every
   * commit in the repo indefinitely. Only the run that actually observed the
   * failed revert blocks anything.
   */
  readonly dirtyWorktrees: Set<string>;
  /**
   * Run-scoped LLM routing-decision cache (BUG-19). Previously a module-level
   * singleton keyed by bare `story.id`, which persisted across `createRuntime()`
   * calls in the same process and could leak a decision from one feature/run
   * into another whose first story happened to route concurrently (or whose
   * `stories[0]` was skipped/paused) — see BUG-19 in
   * docs/reviews/2026-08-11-code-review-latent-bugs-v2.md for the full
   * mechanism. Scoping the cache to the runtime means each run starts with
   * an empty cache; no explicit "clear on first story" heuristic is needed.
   */
  readonly routingCache: Map<string, RoutingDecision>;
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  parentSignal?: AbortSignal;
  sessionManager?: ISessionManager;
  agentManager?: IAgentManager;
  costAggregator?: ICostAggregator;
  promptAuditor?: IPromptAuditor;
  reviewAuditor?: IReviewAuditor;
  /**
   * Feature name — used as a subdirectory under the audit dir so each feature
   * has its own folder. Required when promptAudit.enabled is true and no custom
   * promptAuditor is provided.
   */
  featureName?: string;
  /**
   * Pre-built PidRegistry. When absent, createRuntime constructs a default
   * PidRegistry(workdir). Supply one in tests to control lifecycle.
   */
  pidRegistry?: PidRegistry;
  /**
   * Pre-built AgentStreamEventBus. When provided (e.g. from bin/nax.ts so the
   * TUI can subscribe before run() starts), the runtime uses it instead of
   * creating a new one. Callers must not close or replace the bus mid-run.
   */
  agentStreamEvents?: IAgentStreamEventBus;
}

export function createRuntime(config: NaxConfig, workdir: string, opts?: CreateRuntimeOptions): NaxRuntime {
  const runId = crypto.randomUUID();

  const controller = new AbortController();
  let parentAbortHandler: (() => void) | undefined;
  if (opts?.parentSignal) {
    parentAbortHandler = () => controller.abort(opts.parentSignal?.reason);
    opts.parentSignal.addEventListener("abort", parentAbortHandler, { once: true });
  }

  const configLoader = createConfigLoader(config);
  const dispatchEvents: IDispatchEventBus = new DispatchEventBus();
  const agentStreamEvents: IAgentStreamEventBus = opts?.agentStreamEvents ?? new AgentStreamEventBus();

  const projectKey = config.name?.trim() || basename(workdir);
  const outputDir = projectOutputDir(projectKey, config.outputDir);
  const globalDir = globalOutputDir();
  const curatorRollupPathValue = curatorRollupPath(globalDir, config.curator?.rollupPath);

  const costDir = join(outputDir, "cost");
  const costAggregator = opts?.costAggregator ?? new CostAggregator(runId, costDir);

  const auditEnabled = config.agent?.promptAudit?.enabled ?? false;
  const auditDir = config.agent?.promptAudit?.dir ?? join(outputDir, "prompt-audit");
  let promptAuditor: IPromptAuditor;
  if (opts?.promptAuditor) {
    promptAuditor = opts.promptAuditor;
  } else if (auditEnabled) {
    if (!opts?.featureName) {
      throw new NaxError(
        "createRuntime: featureName is required when promptAudit.enabled is true",
        "AUDIT_FEATURE_NAME_REQUIRED",
        { stage: "runtime" },
      );
    }
    promptAuditor = new PromptAuditor(runId, auditDir, opts.featureName);
  } else {
    promptAuditor = createNoOpPromptAuditor();
  }

  const reviewAuditor =
    opts?.reviewAuditor ??
    (config.review?.audit?.enabled ? new ReviewAuditor(runId, outputDir) : createNoOpReviewAuditor());

  const defaultAgent = config.agent?.default ?? "claude";
  const pidRegistry = opts?.pidRegistry ?? new PidRegistry(workdir);

  const watchdogControllerRegistry = new Map<string, () => Promise<void>>();

  let agentManager: IAgentManager | undefined;
  const middleware = MiddlewareChain.from([cancellationMiddleware()]);
  const sessionManager = opts?.sessionManager ?? new SessionManager();
  if (sessionManager instanceof SessionManager) {
    sessionManager.configureRuntime({
      config,
      getAdapter: (name) => agentManager?.getAgent(name),
      dispatchEvents,
      defaultAgent,
      pidRegistry,
      watchdogControllerRegistry,
      onStreamActivity: (event) => agentStreamEvents.emitAgentStream(event),
      agentStreamEvents,
      // Native session transcripts are written under the run's output dir
      // (a sibling of `runs/`), never the project tree — see
      // deriveNativeTranscriptDir in session/manager-deps.ts.
      transcriptRoot: outputDir,
    });
  }
  const agentManagerOpts: CreateAgentManagerOpts = {
    middleware,
    runId,
    sendPrompt: (handle, prompt, sendOpts) => sessionManager.sendPrompt(handle, prompt, sendOpts),
    runHop: createSessionRunHop(sessionManager, () => agentManager),
    dispatchEvents,
  };
  if (opts?.agentManager instanceof AgentManager) {
    opts.agentManager.configureRuntime({ ...agentManagerOpts, pidRegistry });
    agentManager = opts.agentManager;
  } else {
    agentManager = opts?.agentManager ?? createAgentManager(config, agentManagerOpts);
  }
  if (agentManager instanceof AgentManager) {
    agentManager.configureRuntime({ pidRegistry });
  }

  const offLogging = attachLoggingSubscriber(dispatchEvents, runId);
  const offCost = attachCostSubscriber(dispatchEvents, costAggregator, runId, getProjectKey(config, workdir));
  const offAudit = attachAuditSubscriber(dispatchEvents, promptAuditor, runId);
  const offReviewAudit = attachReviewAuditSubscriber(dispatchEvents, reviewAuditor, runId);
  const offAgentStreamLogging = attachAgentStreamLogging(agentStreamEvents, runId);
  const offWatchdog = attachAgentIdleWatchdog(agentStreamEvents, watchdogControllerRegistry, config);

  const packages = createPackageRegistry(configLoader, workdir);
  const logger = getLogger();
  const quarantineMemo = createQuarantineMemo();
  const adversarialIterations = new Map<string, Iteration[]>();
  const semanticIterations = new Map<string, Iteration[]>();
  const rectificationOscillations = new Map<string, number>();
  const reviewFindingRecurrences: ReviewRecurrenceStore = new Map();
  const agentFallbacks = new Map<string, AgentFallbackRecord[]>();
  const runtimeCrashRetries = new Map<string, number>();
  const storyFixHistory = createStoryFixHistory();
  const mutationSummaries = new Map<string, MutationStorySummary>();
  const dirtyWorktrees = new Set<string>();
  const routingCache = new Map<string, RoutingDecision>();

  let closed = false;

  return {
    runId,
    configLoader,
    workdir,
    projectDir: workdir, // Wave 1: equal to workdir; Wave 3 will separate worktree paths
    outputDir,
    globalDir,
    curatorRollupPath: curatorRollupPathValue,
    projectKey,
    agentManager,
    sessionManager,
    costAggregator,
    promptAuditor,
    reviewAuditor,
    dispatchEvents,
    agentStreamEvents,
    packages,
    pidRegistry,
    logger,
    quarantineMemo,
    adversarialIterations,
    semanticIterations,
    rectificationOscillations,
    reviewFindingRecurrences,
    agentFallbacks,
    runtimeCrashRetries,
    storyFixHistory,
    mutationSummaries,
    dirtyWorktrees,
    routingCache,

    get signal() {
      return controller.signal;
    },
    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      offLogging();
      offCost();
      offAudit();
      offReviewAudit();
      offAgentStreamLogging();
      offWatchdog();
      if (opts?.parentSignal && parentAbortHandler) {
        opts.parentSignal.removeEventListener("abort", parentAbortHandler);
      }
      agentManager.close();
      if (sessionManager instanceof SessionManager) sessionManager.close();
      const results = await Promise.allSettled([promptAuditor.flush(), reviewAuditor.flush(), costAggregator.drain()]);
      for (const r of results) {
        if (r.status === "rejected") {
          logger.warn("runtime", "close() flush/drain error", { error: String(r.reason) });
        }
      }
    },
  };
}

// Suppress unused import warnings — these are re-exported above for the barrel.
void createNoOpCostAggregator;
void createNoOpPromptAuditor;
void createNoOpReviewAuditor;
