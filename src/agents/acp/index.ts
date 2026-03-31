/**
 * ACP Agent Adapter — barrel exports
 */

export { AcpAgentAdapter, _acpAdapterDeps, _fallbackDeps } from "./adapter";
export { createSpawnAcpClient } from "./spawn-client";
export { parseAgentError } from "./parse-agent-error";
export type { AgentRegistryEntry } from "./types";
