# Changelog

All notable changes to `@nathapp/nax-agent` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While the version is `0.x`, a minor
release may change the public API.

## [Unreleased]

### Added

- `attachTurnSpend(err, spend)` and `readTurnSpend(err)`, with the `FailedTurnSpend` type: a backend attaches the spend a failed turn had already incurred to the error it throws, and the turn's `turn_end` reports it (#2367).
- `OpenSessionOpts.toolAudit` (optional `{ dir, header }`): where an ACP session writes its tool-audit ledger. Native ignores it.
- `resultBytes` (optional) on the `tool_result` turn event: the UTF-8 byte length of the full result before the preview cap.
- `ToolAuditHeader` is exported from the package entry.
- `AGENT_SESSION_RATE_LIMITED` error code (a backend's rate-limited turn).

### Fixed

- `turn_end` of an errored, cancelled or timed-out turn carries `costSource` when the failed turn's spend says how it was priced (#2367).

## [0.3.0] - 2026-10-06

The backend seam for S4. Breaking: `createAgentSession` takes a `SessionBackend`. nax behaviour unchanged.

### Changed

- **Breaking:** `CreateAgentSessionOptions.backend` is a `SessionBackend` (was `"native"`). `model`, `credentials`, `catalogOverrides`, `loopHandlers`, `hostPorts`, `bashApproval` and `allowUnsandboxed` move into `nativeBackend({ ... })`. A native-only key at the top level is `AGENT_SESSION_INVALID_OPTIONS`.
- `resumeAgentSession` refuses a document written by another backend kind (`AGENT_SESSION_BACKEND_MISMATCH`); documents without a `backend` field are native.

### Added

- `SessionBackend`, `BackendOpenContext`, `OpenedBackend`, `BackendInfo`, `TurnContribution`, `SessionAskPort`, `ApprovalRequest`, and `nativeBackend` with `NativeBackendOptions`. `AgentSession.backend` reports the backend's kind and capabilities.
- The `ask` profile: every Write, Edit, Delete, GitCommit and Bash is approved through `answer()`; it requires `bashApproval: "gated"` and the sandbox floor of `full`.
- `ApprovalDecidedBy` gains `"profile"`; `usage` and `turn_end` gain `costSource` (`computed` | `reported` | `unpriced`; `CostSource`); `TurnResult` gains `costSource`.
- Error codes `AGENT_SESSION_BACKEND_UNAVAILABLE`, `AGENT_SESSION_AUTH_REQUIRED`, `AGENT_SESSION_CAPABILITY_UNSUPPORTED`, `AGENT_SESSION_BACKEND_MISMATCH`.
- `TranscriptDoc.backend` and `TranscriptDoc.acp` (`TranscriptAcpRecord`), optional and additive (schemaVersion stays 1).
- `TranscriptAcpRecord.costUsd`: the ACP agent's cumulative cost reading at the session's last priced turn, so a resumed ACP session prices its next turn from it.
- Backend kit on `.`: `redactSecrets`, `capStrings`, `killProcessGroup`, `isProcessAlive`, `TOOL_CALL_INPUT_BYTES`, `TOOL_RESULT_PREVIEW_BYTES`, `createStderrTail` (`StderrTail`), and `NaxError`, the base class of `AgentSessionError`, so a backend can throw codes outside `AgentSessionErrorCode` (S4 spec §5.7).
- `getLogger` on `.`: the logger the host installed with `setAgentLogger`, or a silent no-op, so a backend can log through the host's logger.
- `SessionAskPort.askQuestion(text, { signal })`: an extra abort source combined with the turn signal, as `ApprovalRequest.signal` is for approvals, so a backend can settle a question when its own request scope ends (S4 spec §6.3 step 5).

## [0.2.0] - 2026-10-05

The conversational session API for embedders. nax behaviour unchanged.

### Added

- `createAgentSession` and `resumeAgentSession`: a multi-turn session with streamed `SessionEvent`s, embedder tools (`EmbedderTool`, approval `"never" | "always"`), approvals and questions answered with `session.answer()`, `cancel()`, `close()`, and the `none` / `read` / `full` tool profiles. Types: `AgentSession`, `CreateAgentSessionOptions`, `AgentSessionHostPorts`, `AgentSessionProfile`, `EmbedderToolContext`, `EmbedderToolResult`, `SessionEvent`, `SessionEventBase`, `SessionEventBody`, `TurnEndStatus`, `ApprovalDecidedBy`, `AnswerReply`, `AnswerStatus`. Errors: `AgentSessionError` with `AgentSessionErrorCode` (`AGENT_SESSION_*`).
- `resumeAgentSession` reopens a stored session after a restart; a turn the dead process left running is reported as `lastTurn.status: "interrupted"`.
- Facade sessions retry a transient provider fault after text has streamed (3 attempts) and emit `stream_reset` for the voided deltas.
- The `TranscriptStore` port: `TranscriptDoc`, `TurnMarker`, `createFileTranscriptStore`, `createMemoryTranscriptStore` (`MemoryTranscriptStore`). `OpenSessionOpts` gains `transcriptStore`, `retainOnClose` and `systemPrompt`.
- Native model calls stream. `SendTurnOpts.onTurnEvent` receives `TurnEvent`s (`TurnEventSink`): text and thinking deltas, `stream_reset`, `tool_call`, `tool_result`, per-call `usage` and `compaction`. Payloads are redacted and byte-capped.
- Per-session credential sources (`CredentialSource`: `memory`, `exec`) and adapter-owned clients (`NativeSessionAdapterOptions`); `AuthStamp.source` may be `memory`.
- The loop-handler and loop-event types are public on `.`: `LoopHandlerSet`, `LoopHandlerEntry`, `LoopHandlerContext`, `LoopEvent`, `LoopEventMap`, `PayloadOf`, `PatchOf`, `ExternalHandlerOf`, `CompleteCallOptions` and the `Before*` / `After*` / `TransformContext*` payload, patch and outcome types. So are the command-interceptor types `CommandInterceptor`, `InterceptRequest`, `InterceptResult`, `ShellInterceptRequest` and `ShellInterceptResult`.
- The `OwnedPathsPolicy` host port with `EMPTY_OWNED_PATHS_POLICY` and `OwnedBashCandidate`: which paths the host owns the writes to, and how its refusals read. nax supplies its own policy; an embedder that injects nothing gets the empty policy.

### Changed

- `resolveWithin` gains a required third parameter (`ownedPaths`). `SandboxPolicyInput` gains `ownedPaths` (required) and `projectStateDir` (optional), and `buildSandboxPolicy` follows.
- Three `ProtectedPathsPolicy` fields (`projectStateDir`, `credentialDir`, `trustStoreFile`) become optional; the sandbox skips the absent ones.
- `Read`, `Glob` and `Grep` refuse a symlink-resolved host credential directory or trust-store file when the workdir contains it, regardless of grant.
- `./internal` (outside semver): the module-scope native session maps are replaced by a per-adapter `NativeSessionState`.

## [0.1.0] - 2026-10-03

First published version. Extracted from nax, where it was the native agent.

### Added

- The session contract, the native session adapter and `nativeComplete`, the tool set, permission
  resolution, the OS sandbox, command-safety and the cost core, behind `@nathapp/nax-agent`.
- Process-wide slots: `setAgentLogger`, `configureCredentials`, and `setAgentRuntime` with a Node
  default (`nodeRuntime`).
- Host ports: `runDeclaredCommand`, `ProtectedPathsPolicy`, `commandInterceptor`.
- `@nathapp/nax-agent/internal`, nax-only and outside semver.
- `api/nax-agent.api.txt`: the built public API, checked in CI.

### Notes

- Requires Node.js >= 22.19.0. No Bun APIs ship in the package.
- `.` exports no `_`-prefixed name; test seams and reset hooks are on `./internal` only.
