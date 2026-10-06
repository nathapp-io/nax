/**
 * `@nathapp/nax-agent-acp/client`: the ACP backend for nax-agent sessions.
 *
 * S4-3 serves text sessions under all four profiles, with permission requests
 * decided by profile (approved through answer() under `ask`). Embedder tools
 * (S4-4), tool and usage events (S4-5) and resume (S4-6) are refused with
 * AGENT_SESSION_CAPABILITY_UNSUPPORTED until their stage lands. Nothing is
 * released before S4-6.
 */
export { acpBackend } from "#src/client/backend";
export { ACP_STOP_CODES, type AcpStopCode } from "#src/client/errors";
export type { AcpAgentSpec, AcpBackendOptions } from "#src/client/options";
export type { AcpAgentName } from "#src/client/registry";
