export {
  createSpinBreaker,
  DEFAULT_SPIN_BREAKER_SETTINGS,
  type ResolvedSpinBreakerSettings,
  SPIN_TERMINAL_NOTICE,
  type SpinBreaker,
  type SpinStopReason,
  type SpinSummary,
  type SpinVerdict,
  spinTerminalNotice,
} from "@nathapp/nax-agent/internal";
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
  NaxAgentStreamEvent,
} from "./agent-stream-events";
export { AgentStreamEventBus, narrowStreamStage } from "./agent-stream-events";
export type {
  CostErrorEvent,
  CostEvent,
  CostScopeHandle,
  CostSnapshot,
  ICostAggregator,
} from "./cost-aggregator";
export {
  _costAggDeps,
  CostAggregator,
  createNoOpCostAggregator,
  type StorySpend,
  storySpendUsd,
  totalSpendUsd,
} from "./cost-aggregator";
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
export type { InFlightResidual, InFlightUsageTracker } from "./in-flight-usage";
export { attachInFlightUsageTracker, toPartialCostEvent } from "./in-flight-usage";
export type { ResolvedIdleWatchdogSettings, WatchdogState } from "./middleware";
export {
  _idleWatchdogDeps,
  attachAgentIdleWatchdog,
  attachAgentStreamLogging,
  attachUsageAuditSubscriber,
  resolveIdleWatchdogSettings,
} from "./middleware";
export type { PackageRegistry, PackageView } from "./packages";
export { createPackageRegistry, storyExecRoot } from "./packages";
export type { ProjectIdentity } from "./paths";
export {
  claimProjectIdentity,
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
export { isSameProject } from "./same-project";
export { formatSessionName } from "./session-name";
export type { CanonicalSessionRole, SessionRole } from "./session-role";
export { isSessionRole, KNOWN_SESSION_ROLES } from "./session-role";
export type { IUsageAuditor, UsageAuditEntry } from "./usage-auditor";
export { _usageAuditorDeps, createNoOpUsageAuditor, UsageAuditor } from "./usage-auditor";

import { basename, isAbsolute, join, resolve } from "node:path";
import { flushOpenToolAuditSinks } from "@nathapp/nax-agent";
import type { IAgentManager } from "../agents";
import type { CreateAgentManagerOpts } from "../agents/factory";
import { createAgentManager } from "../agents/factory";
import { AgentManager } from "../agents/manager";
import type { AgentFallbackRecord } from "../agents/manager-types";
import type { ConfigLoader, NaxConfig } from "../config";
import { createConfigLoader, getProjectKey } from "../config";
import { PidRegistry } from "../execution/pid-registry";
import type { Logger } from "../logger";
import { getLogger, getSafeLogger } from "../logger";
import { buildMcpRollup, createMcpPool, createMcpProviders, writeMcpRollup } from "../mcp";
import type { RunMemory } from "../memory";
import { loadResourceCatalog } from "../resources";
import type { IReviewAuditor } from "../review/review-audit";
import { createNoOpReviewAuditor, ReviewAuditor } from "../review/review-audit";
import type { RoutingDecision } from "../routing/decision";
import { repairRunState } from "../runstate";
import type { ISessionManager } from "../session";
import { SessionManager } from "../session";
import { MiddlewareChain } from "./agent-middleware";
import type { IAgentStreamEventBus } from "./agent-stream-events";
import { AgentStreamEventBus } from "./agent-stream-events";
import type { ICostAggregator } from "./cost-aggregator";
import { CostAggregator, createNoOpCostAggregator } from "./cost-aggregator";
import type { IDispatchEventBus } from "./dispatch-events";
import { DispatchEventBus } from "./dispatch-events";
import { attachInFlightUsageTracker, toPartialCostEvent } from "./in-flight-usage";
import {
  attachAgentIdleWatchdog,
  attachAgentStreamLogging,
  attachAuditSubscriber,
  attachCostSubscriber,
  attachLoggingSubscriber,
  attachReviewAuditSubscriber,
  attachUsageAuditSubscriber,
  cancellationMiddleware,
} from "./middleware";
import type { PackageRegistry } from "./packages";
import { createPackageRegistry } from "./packages";
import { globalOutputDir, projectOutputDir } from "./paths";
import type { IPromptAuditor } from "./prompt-auditor";
import { createNoOpPromptAuditor, PromptAuditor } from "./prompt-auditor";
import { closeRunTmp } from "./run-tmp-close";
import { withRunMemory, withRunSkills } from "./run-tool-providers";
import { createRunTurnHooks } from "./run-turn-hooks";
import type { CreateRuntimeOptions } from "./runtime-options";
import { createSessionRunHop } from "./session-run-hop";
import type { IUsageAuditor } from "./usage-auditor";
import { createNoOpUsageAuditor, UsageAuditor } from "./usage-auditor";

export interface NaxRuntime {
  readonly runId: string;
  readonly configLoader: ConfigLoader;
  readonly workdir: string;
  readonly projectDir: string;
  readonly outputDir: string;
  readonly globalDir: string;
  readonly projectKey: string;
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;
  readonly costAggregator: ICostAggregator;
  readonly promptAuditor: IPromptAuditor;
  readonly usageAuditor: IUsageAuditor;
  readonly reviewAuditor: IReviewAuditor;
  readonly dispatchEvents: IDispatchEventBus;
  readonly agentStreamEvents: IAgentStreamEventBus;
  readonly packages: PackageRegistry;
  readonly pidRegistry: PidRegistry;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /**
   * True when this run is a `--dry-run`. Run-scoped because the auto-commit
   * refusal it feeds (nax#1808) is needed by call sites that share no arguments
   * and all reach the runtime through DispatchContext.
   */
  readonly dryRun: boolean;
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
   * Where each (story, tier, agent, role) sits on its fallback ladder, keyed by
   * `ladderSlotKey`. Holds the endpoint the slot landed on AND its ladder index,
   * because the two must always agree — splitting them across two maps written
   * from two layers is what let nax#1964's `finalAgent` be returned and never
   * consumed. Written by callOp only when a swap actually occurred; read by callOp
   * before it resolves a dispatch target.
   */
  readonly ladderSlots: Map<string, import("../agents/ladder-slot").LadderSlot>;
  /**
   * The most recent adapter failure per story, written by callOp.
   *
   * The post-run inspection layer used to rebuild ctx.agentResult from the
   * implementer's phase output, which dropped everything the AgentResult carried
   * -- including whether the failure was a rate limit, which the run log then
   * reported as false on every rate-limited story (nax#1897). That rebuild is gone
   * with the layer itself (US-003), but the field stays: result-side data may not
   * travel back through CallContext (adapter-wiring.md Rule 6), so it travels
   * here, exactly as agent-swap hops do (nax#1707). Last write wins.
   */
  readonly lastAdapterFailure: Map<string, import("../context/engine").AdapterFailure>;
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
  /**
   * MCP connection pool for this run, keyed by (serverId, workdir). Closed by
   * `close()`. Exposed so the run rollup can read its lifecycle events.
   */
  readonly mcpPool: import("../mcp").McpPool;
  /**
   * Tool providers advertised to every native dispatch this run. Built from
   * `config.mcp`, followed by skills when `resources.skillsInRun` is enabled,
   * followed by the run memory's when this run has one.
   */
  readonly toolProviders: readonly import("@nathapp/nax-agent").ToolProvider[];
  /**
   * The run's memory, when the run has one — its tools are the last entry of
   * `toolProviders` and `close()` ends it with one more sync. Absent on the
   * entry points that never compose one (plan, bot review, bot fix), so a
   * consumer reads `runtime.memory?.index()` rather than assuming it.
   */
  readonly memory?: RunMemory;
  /**
   * The run's command interceptor (US-003; S1 spec port 7). Installed by
   * `setupRun`; absent for entry points that never run it (plan, prompts,
   * setup), where interception does not apply.
   */
  readonly commandInterceptor?: import("@nathapp/nax-agent/internal").CommandInterceptor;
  close(): Promise<void>;
}

export type { CreateRuntimeOptions } from "./runtime-options";

/** Injectable logger lookup for runtime construction warnings. */
export const _runtimeLoggerDeps = { getSafeLogger };

/** Injectable for tests: the afterTurn run-state repair (#2497). */
export const _runtimeRunStateDeps = { repairRunState };

/** Lazy resource discovery for opted-in run dispatches. */
export const _runtimeResourceDeps = { loadResourceCatalog };

export const _runtimeTmpDeps = { closeRunTmp };

function warnMissingPromptAuditIdentity(auditEnabled: boolean, workdir: string): void {
  if (!auditEnabled) return;
  _runtimeLoggerDeps
    .getSafeLogger()
    ?.warn("runtime", "Prompt audit is enabled but no feature name was given; prompts will not be audited", {
      workdir,
    });
}

/** The runtime's `memory` key: on a run that has one, and absent — not `undefined` — otherwise. */
const memoryKey = (memory: RunMemory | undefined): { memory?: RunMemory } => (memory ? { memory } : {});

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

  const costDir = join(outputDir, "cost");
  const costAggregator = opts?.costAggregator ?? new CostAggregator(runId, costDir);

  const auditEnabled = config.agent?.promptAudit?.enabled ?? false;
  const auditDir = config.agent?.promptAudit?.dir ?? join(outputDir, "prompt-audit");
  let promptAuditor: IPromptAuditor;
  if (opts?.promptAuditor) {
    promptAuditor = opts.promptAuditor;
  } else if (auditEnabled && opts?.featureName) {
    promptAuditor = new PromptAuditor(runId, auditDir, opts.featureName);
  } else {
    promptAuditor = createNoOpPromptAuditor();
    warnMissingPromptAuditIdentity(auditEnabled, workdir);
  }

  const reviewAuditor =
    opts?.reviewAuditor ??
    (config.review?.audit?.enabled ? new ReviewAuditor(runId, outputDir) : createNoOpReviewAuditor());

  // Usage sidecar. Two deliberate departures from promptAudit above: no
  // `featureName` gate (enabled is enough — the ad-hoc runs most worth
  // measuring have no feature name), and a flat `usage/<runId>.jsonl` layout
  // (matching `cost/<runId>.jsonl`), since there is no feature to nest under.
  const usageEnabled = config.agent?.usageAudit?.enabled ?? false;
  const configuredUsageDir = config.agent?.usageAudit?.dir;
  const usageDir =
    configuredUsageDir === undefined
      ? join(outputDir, "usage")
      : isAbsolute(configuredUsageDir)
        ? configuredUsageDir
        : resolve(workdir, configuredUsageDir);
  let usageAuditor: IUsageAuditor;
  if (opts?.usageAuditor) {
    usageAuditor = opts.usageAuditor;
  } else if (usageEnabled) {
    usageAuditor = new UsageAuditor(runId, usageDir);
  } else {
    usageAuditor = createNoOpUsageAuditor();
  }

  const pidRegistry = opts?.pidRegistry ?? new PidRegistry(workdir);

  // Constructed synchronously and connected LAZILY: a run does not know its
  // stage set upfront, and an eager connect would pay subprocess cost for
  // servers no executed stage ever reaches.
  const mcpPool = createMcpPool({
    servers: config.mcp?.servers ?? {},
    pidRegistry,
  });
  const mcpWithheld: import("../mcp").McpWithheldEntry[] = [];
  const mcpProviders = createMcpProviders({
    config: config.mcp,
    pool: mcpPool,
    projectRoot: workdir,
    onWithheld: (entry) => mcpWithheld.push(entry),
  });

  const resourceOptions = { repoRoot: workdir, config, env: process.env, naxPluginPackages: [] };
  const runSkills = withRunSkills(mcpProviders, config, () =>
    _runtimeResourceDeps.loadResourceCatalog(resourceOptions),
  );
  const toolProviders = withRunMemory(runSkills, opts?.memory);

  const watchdogControllerRegistry = new Map<string, () => Promise<void>>();

  let agentManager: IAgentManager | undefined;
  const middleware = MiddlewareChain.from([cancellationMiddleware()]);
  const sessionManager = opts?.sessionManager ?? new SessionManager();
  if (sessionManager instanceof SessionManager) {
    sessionManager.configureRuntime({
      config,
      getAdapter: (name) => agentManager?.getAgent(name),
      pidRegistry,
      watchdogControllerRegistry,
      onStreamActivity: (event) => agentStreamEvents.emitAgentStream(event.runId ? event : { ...event, runId }),
      agentStreamEvents,
      // Native session transcripts are written under the run's output dir
      // (a sibling of `runs/`), never the project tree — see
      // deriveNativeTranscriptDir in session/manager-deps.ts.
      transcriptRoot: outputDir,
      // #2497 run-state repair + nax#2500 reviewer tree guard, native and ACP.
      turnHooks: createRunTurnHooks({ repairRunState: (ctx) => _runtimeRunStateDeps.repairRunState(ctx) }),
    });
  }
  const agentManagerOpts: CreateAgentManagerOpts = {
    middleware,
    runId,
    sendPrompt: (handle, prompt, sendOpts) => sessionManager.sendPrompt(handle, prompt, sendOpts),
    runHop: createSessionRunHop(sessionManager, () => agentManager, runId),
    dispatchEvents,
    // Fallback swap identity resolution (fallback-model-identity.ts) needs `models`,
    // which agentManagerConfigSelector deliberately excludes from AgentManagerConfig
    // (ADR-019). This is the one place with the full NaxConfig in scope, so it is
    // threaded in here as an explicit DI seam rather than widening the selector.
    models: config.models,
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
  const offUsageAudit = attachUsageAuditSubscriber(agentStreamEvents, dispatchEvents, usageAuditor, runId);
  const offAgentStreamLogging = attachAgentStreamLogging(agentStreamEvents, runId);
  const offWatchdog = attachAgentIdleWatchdog(agentStreamEvents, watchdogControllerRegistry, config);
  // In-flight native spend, tracked independently of `agent.usageAudit.enabled`:
  // the ledger's partial row is written by `close()` below, not by the sidecar.
  const { tracker: inFlightTracker, off: offInFlightUsage } = attachInFlightUsageTracker(
    agentStreamEvents,
    dispatchEvents,
  );

  const packages = createPackageRegistry(configLoader, workdir);
  const logger = getLogger();
  const agentFallbacks = new Map<string, AgentFallbackRecord[]>();
  const ladderSlots = new Map<string, import("../agents/ladder-slot").LadderSlot>();
  const lastAdapterFailure = new Map<string, import("../context/engine").AdapterFailure>();
  const routingCache = new Map<string, RoutingDecision>();

  // The one teardown, awaited by every later `close()`. An arrow, not a hoisted declaration:
  // a declaration is created before `agentManager` is assigned, costing the body its narrowing.
  let teardown: Promise<void> | undefined;
  const closeRuntime = async (): Promise<void> => {
    controller.abort();
    offLogging();
    offCost();
    offAudit();
    offReviewAudit();
    offUsageAudit();
    offAgentStreamLogging();
    offWatchdog();
    offInFlightUsage();
    if (opts?.parentSignal && parentAbortHandler) {
      opts.parentSignal.removeEventListener("abort", parentAbortHandler);
    }
    // Run teardown: a pre-built AgentManager (opts.agentManager) may be reused
    // across runs, so clear its per-run state — the per-story hop budget,
    // cooldowns, and pruned fallback set — before releasing it. MEM-12.
    //
    // The run memory closes in the `finally`: a rejecting MCP close or flush
    // must not skip the run-end sync, which is the last thing a note saved by
    // this run's last session needs. Its own failures are its contract's to
    // absorb, so this adds none of its own.
    try {
      agentManager.reset();
      agentManager.close();
      if (sessionManager instanceof SessionManager) sessionManager.close();
      await mcpPool.close();
      await writeMcpRollup(outputDir, buildMcpRollup({ runId, events: mcpPool.events(), withheld: mcpWithheld })).catch(
        (error: unknown) => logger.warn("runtime", "mcp rollup write failed", { error: String(error) }),
      );
      // Native turns still unrecorded at close carry spend the usage sidecar
      // sees but the ledger does not. Record each as a partial `CostEvent`
      // before the drain below, so `run.complete` / status.json (both read
      // `totalSpendUsd(costAggregator.snapshot())`) reflect it.
      for (const residual of inFlightTracker.residuals()) {
        costAggregator.record(toPartialCostEvent(residual, runId, projectKey));
      }
      // Tool calls still buffered by a hop whose `finally` will not run before
      // `process.exit` are written here, as partial, before the drain below.
      // Never rejects (one sink's failure is logged and the rest proceed), so
      // it needs no `.catch` of its own.
      await flushOpenToolAuditSinks(runId);
      const results = await Promise.allSettled([
        promptAuditor.flush(),
        usageAuditor.flush(),
        reviewAuditor.flush(),
        costAggregator.drain(),
      ]);
      for (const r of results) {
        if (r.status === "rejected") {
          logger.warn("runtime", "close() flush/drain error", { error: String(r.reason) });
        }
      }
    } finally {
      try {
        await opts?.memory?.close();
      } finally {
        await _runtimeTmpDeps.closeRunTmp({ runId, dryRun: opts?.dryRun ?? false });
      }
    }
  };

  return {
    runId,
    configLoader,
    workdir,
    projectDir: workdir, // Wave 1: equal to workdir; Wave 3 will separate worktree paths
    outputDir,
    globalDir,
    projectKey,
    agentManager,
    sessionManager,
    costAggregator,
    promptAuditor,
    usageAuditor,
    reviewAuditor,
    dispatchEvents,
    agentStreamEvents,
    packages,
    pidRegistry,
    mcpPool,
    toolProviders,
    ...memoryKey(opts?.memory),
    commandInterceptor: opts?.commandInterceptor,
    logger,
    agentFallbacks,
    ladderSlots,
    lastAdapterFailure,
    dryRun: opts?.dryRun ?? false,
    routingCache,

    get signal() {
      return controller.signal;
    },
    close() {
      // Memoized, not flagged: a second caller (a signal handler and a normal exit both
      // reach here) awaits the running teardown instead of resolving ahead of the memory sync.
      teardown ??= closeRuntime();
      return teardown;
    },
  };
}

// Suppress unused import warnings — these are re-exported above for the barrel.
void createNoOpCostAggregator;
void createNoOpPromptAuditor;
void createNoOpReviewAuditor;
