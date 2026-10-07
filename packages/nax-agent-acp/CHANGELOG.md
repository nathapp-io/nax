# Changelog

All notable changes to `@nathapp/nax-agent-acp` are recorded here. Versions move in
step with `@nathapp/nax-agent`.

## [Unreleased]

### Fixed

- An errored or cancelled turn's `turn_end` carries the usage, cost and `costSource` the turn had already reported, instead of zero (#2367). A cancelled turn whose agent answers within the grace period emits its `usage` event before `turn_end`. Needs `@nathapp/nax-agent` 0.3.1.

## [0.3.0] - 2026-10-06

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
- Turn events, usage and questions on `acpBackend()` (S4-5). Agent thoughts become
  `thinking_delta`. Tool calls become `tool_call` / `tool_result`: sent when the
  call is used, one result per call, calls still running at turn end closed as not
  answered. Each turn ends with one `usage` event with the agent's per-turn tokens
  and the turn's share of its cumulative reported cost (`costSource: "reported"`,
  else `"unpriced"`). Session secret values, the tool host's token included, are
  scrubbed from agent text, thinking and `turn_end.output`, also when split across
  chunks. Form elicitations become `question` events under `ask` and `full`, one per
  field (single- and multi-select, free text, Claude's "Other" box); other forms are
  declined, and an unanswered or abandoned form is cancelled. Needs nax-agent's
  `askQuestion(text, { signal })`.
- Resume and reconnect on `acpBackend()` (S4-6). `resumeAgentSession` restores the
  agent's own session in a new process with `session/resume`, else `session/load`,
  never as a fresh session. The stored record is checked before anything starts:
  backend, agent, session id and directory. A lost session is
  `AGENT_SESSION_NOT_FOUND`, and a different restored session is
  `AGENT_SESSION_TURN_FAILED` (`detail: "identity"`). A `session/load` replay never
  reaches the caller. The mode and model are re-applied, and the tool host restarts
  with a new token. After a crash or kill, the next turn reconnects once the same
  way; otherwise later turns end `AGENT_SESSION_CLOSED`. The cost baseline is saved
  in the transcript (`acp.costUsd`), so the first turn after a resume costs only its
  own share. `AgentSession.backend.capabilities.restoredWith` reports `"resume"` or
  `"load"`.
- Packed-tarball smoke of both packages on Node 22 and 24, and the S4 acceptance
  procedure with its live Claude and initialize-only fixtures (`RELEASING.md`).
- Embedder tools are listed with the MCP annotation `readOnlyHint: true` (#2365).
  Claude's plan mode, used by the `none` and `read` profiles, asked before any MCP
  tool not marked read-only, ahead of the `mcp__nax__<tool>` pre-approval, so the
  profile then denied the session's own tools.
- Under `none` and `read`, Claude sessions disallow `ExitPlanMode` (#2365). Asked
  to change something, Claude asked to leave plan mode, the profile refused, and the
  adapter turned that refusal into an interrupt, so the turn ended
  `ACP_STOP_CANCELLED`. The `_meta` is now sent even when the session has no tools.
