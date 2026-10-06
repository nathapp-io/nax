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
