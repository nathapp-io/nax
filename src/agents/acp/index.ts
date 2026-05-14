/**
 * ACP Agent Adapter — barrel exports
 */

export {
  AcpAgentAdapter,
  AcpSessionHandleImpl,
  _acpAdapterDeps,
  _fallbackDeps,
  MAX_AGENT_OUTPUT_CHARS,
} from "./adapter";
export type { AcpClient, AcpSession, AcpSessionResponse } from "./adapter-session-types";
export type { AcpClientOptions } from "./adapter-session-types";
export {
  SpawnAcpClient,
  _spawnClientDeps,
  createSpawnAcpClient,
} from "./spawn-client";
export type {
  AcpxLineActivity as AcpLineActivity,
  AcpxParseState as AcpParseState,
} from "./parser";
export {
  createParseState,
  finalizeParseState,
  parseAcpxJsonLine,
  parseAcpxJsonOutput,
} from "./parser";
export { parseAgentError } from "./parse-agent-error";
export { computeAcpHandle } from "./adapter-lifecycle";
export type { AgentRegistryEntry } from "./types";
export type { SessionTokenUsage } from "./wire-types";
export { AcpTokenUsageMapper, defaultAcpTokenUsageMapper } from "./token-mapper";
