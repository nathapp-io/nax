import type { NaxConfig } from "../config";
import { AgentManager } from "./manager";
import type { IAgentManager } from "./manager-types";

/**
 * Single construction point for AgentManager. Pre-run phases and CLI entry
 * points call this. Mid-run code must receive IAgentManager via context/DI —
 * it must NOT call this factory. See docs/specs/SPEC-agent-manager-lifetime.md §2.1.
 */
export function createAgentManager(config: NaxConfig): IAgentManager {
  return new AgentManager(config);
}
