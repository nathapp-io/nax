import { createAgentManager as createAgentManagerFromAgents } from "../../agents";
import type { IAgentManager } from "../../agents";
import type { NaxConfig } from "../../config";

export function createAgentManager(config: NaxConfig): IAgentManager {
  return createAgentManagerFromAgents(config);
}
