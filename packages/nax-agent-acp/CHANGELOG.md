# Changelog

All notable changes to `@nathapp/nax-agent-acp` are recorded here. Versions move in
step with `@nathapp/nax-agent`.

## [Unreleased]

- Package scaffold: `./client` and `./server` entries, build, gates and release wiring.
- `acpBackend()` on `./client` (S4-2): launches the agent as a process-group leader,
  initializes over `@agentclientprotocol/sdk`, checks capabilities, opens the session,
  applies the profile's mode and the model, and runs text-only `full` turns with
  cancel, crash and close handling. Exports `ACP_STOP_CODES` and the `AcpStopCode`,
  `AcpAgentName`, `AcpAgentSpec` and `AcpBackendOptions` types.
- Profiles `none`, `read`, `ask` and `full` on `acpBackend()` (S4-3). The agent's
  mode is set by profile, and each `session/request_permission` is decided by profile:
  rejected under `none`/`read`, put to the caller through `approval_requested` and
  `answer()` under `ask`, allowed under `full`. Only one-time options are chosen.
  Auto-decisions are recorded with `decidedBy: "profile"`. Agent text in approval
  events is stripped, redacted and capped; oversized or unmaskable text is withheld.
  Pending approvals settle `cancelled` when the turn is cancelled, ends or loses its
  agent process, and a request after `cancel()` is never allowed. Out-of-turn,
  foreign-session and over-cap (16 concurrent) requests are rejected locally.
- Embedder tools on `acpBackend()` (S4-4). A per-session MCP server on `127.0.0.1`
  (ephemeral port, path `/mcp`) serves the session's tools to the agent: bearer
  token compared in constant time, `Host` and `Origin` checks, a 1 MiB body cap,
  at most 8 concurrent calls, no CORS. Claude's adapter pre-approves each tool with
  an exact `mcp__nax__<tool>` rule, so the tool's own `approval` is its only gate.
  Calls run only during a turn, under the turn's signal, and are abandoned when it
  stops. The token is redacted everywhere and never stored; the server stops on
  close. Agents without HTTP MCP or pre-approval refuse tools after `initialize`.
