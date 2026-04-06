/**
 * ACP Agent Adapter — barrel exports
 */

export { AcpAgentAdapter, _acpAdapterDeps, _fallbackDeps } from "./adapter";
export { createSpawnAcpClient } from "./spawn-client";
export { parseAgentError } from "./parse-agent-error";
export { writePromptAudit, _promptAuditDeps } from "./prompt-audit";
export type { AgentRegistryEntry } from "./types";
