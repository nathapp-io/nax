/**
 * ACP Agent Adapter — barrel exports
 */

export { AcpAgentAdapter, _acpAdapterDeps, _fallbackDeps, MAX_AGENT_OUTPUT_CHARS } from "./adapter";
export { createSpawnAcpClient } from "./spawn-client";
export { parseAgentError } from "./parse-agent-error";
export { writePromptAudit, findNaxProjectRoot, _promptAuditDeps } from "./prompt-audit";
export type { AgentRegistryEntry } from "./types";
