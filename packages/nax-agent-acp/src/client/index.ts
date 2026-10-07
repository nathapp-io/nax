/**
 * `@nathapp/nax-agent-acp/client`: the ACP backend for nax-agent sessions.
 *
 * Sessions under all four profiles: permission requests decided by profile
 * (approved through answer() under `ask`), embedder tools through a per-session
 * loopback MCP tool host that Claude's adapter pre-approves, thinking, tool and
 * usage events, the agent's form elicitations as questions, resume of a stored
 * session in a new process (session/resume, else session/load), and one reconnect
 * after the agent process dies (S4-6).
 */
export { acpBackend } from "#src/client/backend";
export { ACP_STOP_CODES, type AcpStopCode } from "#src/client/errors";
export { isAgentLaunchable, type LaunchCandidateKind, launchCandidateKind } from "#src/client/launchable";
export type { AcpAgentSpec, AcpBackendOptions, AcpProcessHooks } from "#src/client/options";
export type { AcpAgentName } from "#src/client/registry";
