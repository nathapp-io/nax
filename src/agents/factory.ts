import type { AgentManagerConfig } from "@/config/selectors";

// Leaf import to avoid barrel cycle (same as in manager.ts):
// src/runtime/index.ts → internal/agent-manager-factory → agents/factory → agents/manager → runtime/index.ts
import type { MiddlewareChain } from "../runtime/agent-middleware";
import type { IDispatchEventBus } from "../runtime/dispatch-events";
import { AgentManager } from "./manager";
import type { SendPromptFn } from "./manager";
import type { IAgentManager } from "./manager-types";
import type { SessionRunHopFn } from "./manager-types";

export interface CreateAgentManagerOpts {
  middleware?: MiddlewareChain;
  runId?: string;
  sendPrompt?: SendPromptFn;
  runHop?: SessionRunHopFn;
  dispatchEvents?: IDispatchEventBus;
}

/**
 * Single construction point for AgentManager. Called only from
 * src/runtime/index.ts (production) and src/cli/plan.ts (CLI entry point).
 * Mid-run code must receive IAgentManager via context/DI —
 * never call this factory directly. See docs/specs/SPEC-agent-manager-lifetime.md §2.1.
 */
export function createAgentManager(config: AgentManagerConfig, opts?: CreateAgentManagerOpts): IAgentManager {
  return new AgentManager(config, undefined, opts);
}
