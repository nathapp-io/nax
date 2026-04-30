export { createNoOpCostAggregator, CostAggregator, _costAggDeps } from "./cost-aggregator";
export type {
  ICostAggregator,
  CostEvent,
  CostErrorEvent,
  CostSnapshot,
} from "./cost-aggregator";
export { createNoOpPromptAuditor, PromptAuditor, _promptAuditorDeps } from "./prompt-auditor";
export type {
  IPromptAuditor,
  PromptAuditEntry,
  PromptAuditErrorEntry,
} from "./prompt-auditor";
export { createNoOpReviewAuditor, ReviewAuditor, _reviewAuditDeps } from "../review/review-audit";
export type {
  IReviewAuditor,
  ReviewAuditDecision,
  ReviewAuditDispatch,
  ReviewAuditEntry,
} from "../review/review-audit";
export type { PackageView, PackageRegistry } from "./packages";
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
} from "./dispatch-events";
export { DispatchEventBus } from "./dispatch-events";

import { join } from "node:path";
import type { IAgentManager } from "../agents";
import type { CreateAgentManagerOpts } from "../agents/factory";
import { AgentManager } from "../agents/manager";
import type { NaxConfig } from "../config";
import { createConfigLoader } from "../config";
import type { ConfigLoader } from "../config";
import { NaxError } from "../errors";
import { PidRegistry } from "../execution/pid-registry";
import { getLogger } from "../logger";
import type { Logger } from "../logger";
import { ReviewAuditor, createNoOpReviewAuditor } from "../review/review-audit";
import type { IReviewAuditor } from "../review/review-audit";
import type { ISessionManager } from "../session";
import { SessionManager } from "../session";
import { MiddlewareChain } from "./agent-middleware";
import { CostAggregator, createNoOpCostAggregator } from "./cost-aggregator";
import type { ICostAggregator } from "./cost-aggregator";
import { DispatchEventBus } from "./dispatch-events";
import type { IDispatchEventBus } from "./dispatch-events";
import { createAgentManager } from "./internal/agent-manager-factory";
import {
  attachAuditSubscriber,
  attachCostSubscriber,
  attachLoggingSubscriber,
  attachReviewAuditSubscriber,
  cancellationMiddleware,
} from "./middleware";
import { createPackageRegistry } from "./packages";
import type { PackageRegistry } from "./packages";
import { PromptAuditor, createNoOpPromptAuditor } from "./prompt-auditor";
import type { IPromptAuditor } from "./prompt-auditor";
import { createSessionRunHop } from "./session-run-hop";

export interface NaxRuntime {
  readonly runId: string;
  readonly configLoader: ConfigLoader;
  readonly workdir: string;
  readonly projectDir: string;
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;
  readonly costAggregator: ICostAggregator;
  readonly promptAuditor: IPromptAuditor;
  readonly reviewAuditor: IReviewAuditor;
  readonly dispatchEvents: IDispatchEventBus;
  readonly packages: PackageRegistry;
  readonly pidRegistry: PidRegistry;
  readonly logger: Logger;
  readonly signal: AbortSignal;
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
}

export function createRuntime(config: NaxConfig, workdir: string, opts?: CreateRuntimeOptions): NaxRuntime {
  const runId = crypto.randomUUID();

  const controller = new AbortController();
  if (opts?.parentSignal) {
    opts.parentSignal.addEventListener("abort", () => controller.abort(opts.parentSignal?.reason), { once: true });
  }

  const configLoader = createConfigLoader(config);
  const dispatchEvents: IDispatchEventBus = new DispatchEventBus();

  const costDir = join(workdir, ".nax", "cost");
  const costAggregator = opts?.costAggregator ?? new CostAggregator(runId, costDir);

  const auditEnabled = config.agent?.promptAudit?.enabled ?? false;
  const auditDir = config.agent?.promptAudit?.dir ?? join(workdir, ".nax", "prompt-audit");
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
    (config.review?.audit?.enabled ? new ReviewAuditor(runId, workdir) : createNoOpReviewAuditor());

  const defaultAgent = config.agent?.default ?? "claude";
  const pidRegistry = opts?.pidRegistry ?? new PidRegistry(workdir);

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
    });
  }
  const agentManagerOpts: CreateAgentManagerOpts = {
    middleware,
    runId,
    sendPrompt: (handle, prompt, sendOpts) => sessionManager.sendPrompt(handle, prompt, sendOpts),
    runHop: createSessionRunHop(sessionManager),
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

  const packages = createPackageRegistry(configLoader, workdir);
  const logger = getLogger();

  let closed = false;

  return {
    runId,
    configLoader,
    workdir,
    projectDir: workdir, // Wave 1: equal to workdir; Wave 3 will separate worktree paths
    agentManager,
    sessionManager,
    costAggregator,
    promptAuditor,
    reviewAuditor,
    dispatchEvents,
    packages,
    pidRegistry,
    logger,
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
