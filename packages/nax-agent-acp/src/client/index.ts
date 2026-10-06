/**
 * `@nathapp/nax-agent-acp/client`: the ACP backend for nax-agent sessions.
 *
 * S4-5 serves sessions under all four profiles: permission requests decided by
 * profile (approved through answer() under `ask`), embedder tools through a
 * per-session loopback MCP tool host that Claude's adapter pre-approves, thinking,
 * tool and usage events, and the agent's form elicitations as questions. Resume
 * (S4-6) is refused with AGENT_SESSION_CAPABILITY_UNSUPPORTED until its stage
 * lands. Nothing is released before S4-6.
 */
export { acpBackend } from "#src/client/backend";
export { ACP_STOP_CODES, type AcpStopCode } from "#src/client/errors";
export type { AcpAgentSpec, AcpBackendOptions } from "#src/client/options";
export type { AcpAgentName } from "#src/client/registry";
