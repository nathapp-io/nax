export { createNoOpCostAggregator, CostAggregator, _costAggDeps } from "./cost-aggregator";
export type {
  ICostAggregator,
  CostEvent,
  CostErrorEvent,
  CostSnapshot,
  CostScopeHandle,
} from "./cost-aggregator";
export { createNoOpPromptAuditor, PromptAuditor, _promptAuditorDeps } from "./prompt-auditor";
export type {
  IPromptAuditor,
  PromptAuditEntry,
  PromptAuditErrorEntry,
} from "./prompt-auditor";
export { createNoOpReviewAuditor, ReviewAuditor, _reviewAuditDeps } from "../review/review-audit";
export type {
  AdvisoryFindingSummaryEntry,
  IReviewAuditor,
  ReviewAuditDecision,
  ReviewAuditDispatch,
  ReviewAuditEntry,
} from "../review/review-audit";
export type { PackageView, PackageRegistry } from "./packages";
export {
  projectInputDir,
  projectOutputDir,
  globalOutputDir,
  identityPath,
  readProjectIdentity,
  writeProjectIdentity,
  claimProjectIdentity,
  curatorRollupPath,
} from "./paths";
export type { ProjectIdentity } from "./paths";
export { createPackageRegistry } from "./packages";
export type { DispatchContext } from "./dispatch-context";
export type { AgentMiddleware, MiddlewareContext } from "./agent-middleware";
export { MiddlewareChain } from "./agent-middleware";
export type {
  IDispatchEventBus,
  DispatchEvent,
  SessionTurnDispatchEvent,
  CompleteDispatchEvent,
  DispatchErrorEvent,
  OperationCompletedEvent,
  ReviewDecisionEvent,
} from "./dispatch-events";
export { DispatchEventBus } from "./dispatch-events";
export type {
  IAgentStreamEventBus,
  AgentStreamEvent,
  AgentStreamEventBase,
  AgentCallStartedEvent,
  AgentMessageUpdateEvent,
  AgentThinkingUpdateEvent,
  AgentToolCallUpdateEvent,
  AgentUsageUpdateEvent,
  AgentProcessUpdateEvent,
  AgentCallEndedEvent,
  AgentStreamListener,
} from "./agent-stream-events";
export { AgentStreamEventBus } from "./agent-stream-events";
export { attachAgentIdleWatchdog, attachAgentStreamLogging, _idleWatchdogDeps } from "./middleware";
export type { WatchdogState } from "./middleware";
export { formatSessionName } from "./session-name";
export { KNOWN_SESSION_ROLES, isSessionRole } from "./session-role";
export type { SessionRole, CanonicalSessionRole } from "./session-role";

import { basename, join } from "node:path";
import type { IAgentManager } from "../agents";
import type { CreateAgentManagerOpts } from "../agents/factory";
import { createAgentManager } from "../agents/factory";
import { AgentManager } from "../agents/manager";
import type { NaxConfig } from "../config";
import { createConfigLoader } from "../config";
import type { ConfigLoader } from "../config";
import { NaxError } from "../errors";
import { PidRegistry } from "../execution/pid-registry";
import type { Iteration } from "../findings";
import { getLogger } from "../logger";
import type { Logger } from "../logger";
import { ReviewAuditor, createNoOpReviewAuditor } from "../review/review-audit";
import type { IReviewAuditor } from "../review/review-audit";
import type { ISessionManager } from "../session";
import { SessionManager } from "../session";
import { type QuarantineMemo, createQuarantineMemo } from "../verification/flake-triage";
import { MiddlewareChain } from "./agent-middleware";
import { AgentStreamEventBus } from "./agent-stream-events";
import type { IAgentStreamEventBus } from "./agent-stream-events";
import { CostAggregator, createNoOpCostAggregator } from "./cost-aggregator";
import type { ICostAggregator } from "./cost-aggregator";
import { DispatchEventBus } from "./dispatch-events";
import type { IDispatchEventBus } from "./dispatch-events";
import {
  attachAgentIdleWatchdog,
  attachAgentStreamLogging,
  attachAuditSubscriber,
  attachCostSubscriber,
  attachLoggingSubscriber,
  attachReviewAuditSubscriber,
  cancellationMiddleware,
} from "./middleware";
import { createPackageRegistry } from "./packages";
import type { PackageRegistry } from "./packages";
import { curatorRollupPath, globalOutputDir, projectOutputDir } from "./paths";
import { PromptAuditor, createNoOpPromptAuditor } from "./prompt-auditor";
import type { IPromptAuditor } from "./prompt-auditor";
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
  const offCost = attachCostSubscriber(dispatchEvents, costAggregator, runId);
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
