import type { IAgentManager } from "../../agents";
import { createAgentManager as createAgentManagerFromFactory } from "../../agents/factory";
import type { NaxConfig } from "../../config";

export function createAgentManager(config: NaxConfig): IAgentManager {
  return createAgentManagerFromFactory(config);
}
