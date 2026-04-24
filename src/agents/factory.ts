import type { NaxConfig } from "../config";
import { AgentManager } from "./manager";
import type { IAgentManager } from "./manager-types";

/**
 * Single construction point for AgentManager. Called only via
 * src/runtime/internal/agent-manager-factory.ts (production) and src/cli/plan.ts
 * (CLI entry point). Mid-run code must receive IAgentManager via context/DI —
 * never call this factory directly. See docs/specs/SPEC-agent-manager-lifetime.md §2.1.
 */
export function createAgentManager(config: NaxConfig): IAgentManager {
  return new AgentManager(config);
}
