/**
 * The options `createRuntime` takes. Split out of `./index` so the runtime barrel
 * stays inside the source-file line cap; every name here is re-exported from it, so
 * no importer changed.
 *
 * Type-only imports throughout: this module is erased at compile time and adds no
 * runtime edge to the barrel it is re-exported from.
 */
import type { CommandInterceptor } from "@nathapp/nax-agent/internal";
import type { IAgentManager } from "../agents";
import type { PidRegistry } from "../execution/pid-registry";
import type { RunMemory } from "../memory";
import type { IReviewAuditor } from "../review/review-audit";
import type { ISessionManager } from "../session";
import type { IAgentStreamEventBus } from "./agent-stream-events";
import type { ICostAggregator } from "./cost-aggregator";
import type { IPromptAuditor } from "./prompt-auditor";
import type { IUsageAuditor } from "./usage-auditor";

export interface CreateRuntimeOptions {
  parentSignal?: AbortSignal;
  sessionManager?: ISessionManager;
  agentManager?: IAgentManager;
  costAggregator?: ICostAggregator;
  promptAuditor?: IPromptAuditor;
  usageAuditor?: IUsageAuditor;
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
  /** Marks the run as a dry run; defaults to false. See NaxRuntime.dryRun. */
  dryRun?: boolean;
  /**
   * Pre-built AgentStreamEventBus. When provided (e.g. from bin/nax.ts so the
   * TUI can subscribe before run() starts), the runtime uses it instead of
   * creating a new one. Callers must not close or replace the bus mid-run.
   */
  agentStreamEvents?: IAgentStreamEventBus;
  /** See NaxRuntime.commandInterceptor. */
  commandInterceptor?: CommandInterceptor;
  /**
   * The run's memory, when the run has one. Its provider is appended to
   * `toolProviders` after MCP and skills, and `close()` closes it. Absent for
   * every entry point that never creates one (plan, bot review, bot fix).
   */
  memory?: RunMemory;
}
