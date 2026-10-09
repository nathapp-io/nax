# Changelog

All notable changes to `@nathapp/nax-agent-acp` are recorded here. Versions move in
step with `@nathapp/nax-agent`.

## [0.84.0] - 2026-10-09

- Versioning: released in lockstep with `@nathapp/nax`, `@nathapp/nax-ai` and the other agent package at one shared version, starting at 0.84.0 (previously 0.3.x).

### Added

- `nax-agent` binary and the `./server` entry (`main`, `runCli`): an ACP server on stdio over nax-agent's native agent. It reads `~/.nax` (models, auth, optional `agentServer` block) and logs to stderr only (S5-0).
- Streamed text, thinking, tool calls with diffs, usage and compaction updates; transcript replay (S5-1).
- `session/new`, `session/prompt`, `session/cancel`; permission requests with per-session always-allow (keyed on command and subcommand); questions via form elicitation, or a canned answer for clients without it (S5-2).
- File-backed sessions: `session/load` (with replay), `resume`, `list`, `close`, `delete`, `set_mode`, `set_config_option` (model, bash approval). A model switch keeps the conversation (S5-3).
- `nax-agent login <provider>`, terminal `authMethods` for clients that declare `auth.terminal`, `authenticate`, and `auth_required` for missing or rejected credentials, checked before a session opens (S5-4).

### Changed

- A model the agent does not offer verbatim still fails the open with `AGENT_SESSION_CAPABILITY_UNSUPPORTED`; the error now lists the model ids the agent does offer (message and `context.offered`, at most 50, cleaned like other agent text).

## [0.3.1] - 2026-10-07

### Added

- A rate-limited prompt (structured `data.errorKind: "rate_limit"`, as Claude's adapter sends) is `AGENT_SESSION_RATE_LIMITED`, classified from structured error data only. Needs `@nathapp/nax-agent` 0.3.1.
- `effort` option: sets the agent's reasoning effort after the model; skipped with a warning when not offered.
- `onProcess` option (`AcpProcessHooks`): `spawned(pid)` and `exited(pid)` for every agent process, including after a reconnect.
- `tool_result` events carry `resultBytes`: the UTF-8 byte length of the full result before the preview cap (0 for a call the turn never answered).
- `isAgentLaunchable` and `launchCandidateKind`: whether a registered agent's launcher resolves on PATH, and whether only the npx fallback does.
- The agent's heartbeats on a running tool surface as `tool_progress` turn events, at most one per call per 30 s; they are not session events.

### Fixed

- An errored or cancelled turn's `turn_end` carries the usage, cost and `costSource` the turn had already reported, instead of zero (#2367). A cancelled turn whose agent answers within the grace period emits its `usage` event before `turn_end`. A turn that ends with no prompt response (killed after the grace, agent gone, or a JSON-RPC error) reports cost 0 with `costSource: "unpriced"`; any reading it saw is billed to the next priced turn. Needs `@nathapp/nax-agent` 0.3.1.
- Session instructions are no longer lost when the agent dies before it has the prompt. They count as delivered on the first turn-content update or the prompt's response; otherwise the next prompt, after the reconnect, carries them again (#2364).
- Profiles `none` and `read` on Claude no longer use plan mode, which wrote its plan file under `~/.claude/plans/` without a permission request. They run in `default` mode with `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and `EnterPlanMode` removed, and load no Claude settings files, so settings allow rules, hooks and MCP servers cannot act outside the profile. Embedder tools no longer carry `readOnlyHint`. Resuming a 0.3.0 `none`/`read` session may rebuild Claude's agent session (#2366).

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
