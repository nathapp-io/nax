/**
 * ACP Agent Adapter — barrel exports
 */

export type { BuildTurnResultInput } from "./adapter";
export {
  _acpAdapterDeps,
  _fallbackDeps,
  ACP_ADAPTER_NAMES,
  AcpAgentAdapter,
  AcpSessionHandleImpl,
  buildTurnResult,
} from "./adapter";
export { computeAcpHandle } from "./adapter-lifecycle";
export type { AcpClient, AcpClientOptions, AcpSession, AcpSessionResponse } from "./adapter-session-types";
export type { ModelSpec } from "./model-spec";
export { parseModelSpec } from "./model-spec";
export { parseAgentError } from "./parse-agent-error";
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
export { parseSessionIds } from "./session-ids";
export {
  _spawnClientDeps,
  createSpawnAcpClient,
  SpawnAcpClient,
} from "./spawn-client";
// @internal — test-reachability re-export only; production code imports
// stdout-line-reader directly from spawn-client.ts.
export { MAX_BUFFERED_LINE_BYTES, readAndParseLines, readStreamTail } from "./stdout-line-reader";
export { AcpTokenUsageMapper, defaultAcpTokenUsageMapper } from "./token-mapper";
export type { AgentRegistryEntry } from "./types";
export type { SessionTokenUsage } from "./wire-types";
