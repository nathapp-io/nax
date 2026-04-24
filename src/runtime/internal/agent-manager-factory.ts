import type { IAgentManager } from "../../agents";
import { createAgentManager as createAgentManagerFromFactory } from "../../agents/factory";
import type { CreateAgentManagerOpts } from "../../agents/factory";
import type { NaxConfig } from "../../config";

export function createAgentManager(config: NaxConfig, opts?: CreateAgentManagerOpts): IAgentManager {
  return createAgentManagerFromFactory(config, opts);
}
