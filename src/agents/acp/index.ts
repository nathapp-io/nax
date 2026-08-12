/**
 * ACP Agent Adapter — barrel exports
 */

export {
  ACP_ADAPTER_NAMES,
  AcpAgentAdapter,
  AcpSessionHandleImpl,
  _acpAdapterDeps,
  _fallbackDeps,
  buildTurnResult,
} from "./adapter";
export type { BuildTurnResultInput } from "./adapter";
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
export { parseModelSpec } from "./model-spec";
export type { ModelSpec } from "./model-spec";
export { parseSessionIds } from "./session-ids";
// @internal — test-reachability re-export only; production code imports
// stdout-line-reader directly from spawn-client.ts.
export { MAX_BUFFERED_LINE_BYTES, readAndParseLines } from "./stdout-line-reader";
