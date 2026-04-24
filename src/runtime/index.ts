export { createNoOpCostAggregator } from "./cost-aggregator";
export type {
  ICostAggregator,
  CostEvent,
  CostErrorEvent,
  CostSnapshot,
} from "./cost-aggregator";
export { createNoOpPromptAuditor } from "./prompt-auditor";
export type {
  IPromptAuditor,
  PromptAuditEntry,
  PromptAuditErrorEntry,
} from "./prompt-auditor";
export type { PackageView, PackageRegistry } from "./packages";
export { createPackageRegistry } from "./packages";

import type { IAgentManager } from "../agents";
import type { NaxConfig } from "../config";
import { createConfigLoader } from "../config";
import type { ConfigLoader } from "../config";
import { getLogger } from "../logger";
import type { Logger } from "../logger";
import type { ISessionManager } from "../session";
import { SessionManager } from "../session";
import { createNoOpCostAggregator } from "./cost-aggregator";
import type { ICostAggregator } from "./cost-aggregator";
import { createAgentManager } from "./internal/agent-manager-factory";
import { createPackageRegistry } from "./packages";
import type { PackageRegistry } from "./packages";
import { createNoOpPromptAuditor } from "./prompt-auditor";
import type { IPromptAuditor } from "./prompt-auditor";

export interface NaxRuntime {
  readonly configLoader: ConfigLoader;
  readonly workdir: string;
  readonly projectDir: string;
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;
  readonly costAggregator: ICostAggregator;
  readonly promptAuditor: IPromptAuditor;
  readonly packages: PackageRegistry;
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
}

export function createRuntime(config: NaxConfig, workdir: string, opts?: CreateRuntimeOptions): NaxRuntime {
  const controller = new AbortController();
  if (opts?.parentSignal) {
    opts.parentSignal.addEventListener("abort", () => controller.abort(opts.parentSignal?.reason), { once: true });
  }

  const configLoader = createConfigLoader(config);
  const agentManager = opts?.agentManager ?? createAgentManager(config);
  const sessionManager = opts?.sessionManager ?? new SessionManager();
  const costAggregator = opts?.costAggregator ?? createNoOpCostAggregator();
  const promptAuditor = opts?.promptAuditor ?? createNoOpPromptAuditor();
  const packages = createPackageRegistry(configLoader, workdir);
  const logger = getLogger();

  let closed = false;

  return {
    configLoader,
    workdir,
    projectDir: workdir,
    agentManager,
    sessionManager,
    costAggregator,
    promptAuditor,
    packages,
    logger,
    get signal() {
      return controller.signal;
    },
    async close() {
      if (closed) return;
      closed = true;
      controller.abort();
      await promptAuditor.flush();
      await costAggregator.drain();
    },
  };
}
