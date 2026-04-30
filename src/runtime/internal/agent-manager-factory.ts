import type { IAgentManager } from "../../agents";
import { createAgentManager as createAgentManagerFromFactory } from "../../agents/factory";
import type { CreateAgentManagerOpts } from "../../agents/factory";
import type { NaxConfig } from "../../config";

type AgentManagerConfig = Pick<NaxConfig, "agent" | "execution">;

export function createAgentManager(config: AgentManagerConfig, opts?: CreateAgentManagerOpts): IAgentManager {
  return createAgentManagerFromFactory(config, opts);
}
