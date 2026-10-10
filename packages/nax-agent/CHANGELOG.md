# Changelog

All notable changes to `@nathapp/nax-agent` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). While the version is `0.x`, a minor
release may change the public API.

## [0.86.0] - 2026-10-10

- No changes in this package. Released in lockstep with the other nax packages.

## [0.85.1] - 2026-10-10

### Added

- `nativeBackend({ compaction })`: `{ enabled?, compactAtPercent?, keepRecentPercent? }`, validated with the same schema as nax's `execution.compaction` (integer percentages of the context window, 50-99 and 5-79, `keepRecentPercent` at least 20 points below `compactAtPercent`). An invalid value throws `AGENT_SESSION_INVALID_OPTIONS`. `compactionSettingsSchema`, `DEFAULT_COMPACTION` and `resolveCompaction` are on `./internal` for nax and the ACP server (#2427).

### Changed

- Behaviour change: conversational sessions (`createAgentSession`, `resumeAgentSession`) now compact their history by default, as `nax run` does. A history past `compactAtPercent` (default 90) of the window is summarised before the round trip, and a context-overflow error is compacted and retried once, so long chats no longer end `errored` at the window. Each compaction adds one billed summary call; it emits no `usage` event. The existing `compaction` event (`reason: "proactive" | "overflow"`) is now emitted on the session stream, and the stored transcript after the turn is the compacted history. Pass `compaction: { enabled: false }` to `nativeBackend` for the old behaviour (#2427).

### Fixed

- Secret redaction now masks values under secret-named keys in JSON text (`{"apiKey": "..."}`, including JSON escaped inside a JSON string) and in env, dotenv, shell and YAML-style lines (`API_TOKEN=...`, `export KEY="..."`, `password: ...`, `Authorization: Bearer ...`), keeping the key and structure. This reaches `tool_result.preview`, `tool_call.input` and the run log. Usage counts (`tokens`, `max_tokens`) and references (`$VAR`, `process.env.X`) are left alone (#2346).

## [0.85.0] - 2026-10-09

### Added

- `listProviderModels(providerId, catalogOverrides?)` and `ProviderModel`: the tool-capable models the catalog offers for one provider, as plain data (#2414).

## [0.84.0] - 2026-10-09

- Versioning: released in lockstep with `@nathapp/nax`, `@nathapp/nax-ai` and the other agent package at one shared version, starting at 0.84.0 (previously 0.3.x).

### Added

- `createTerminalAuthInteraction({ log, style?, openUrl? })`, `PromptCancelledError`, `TerminalStyle` and `PLAIN_STYLE`: the terminal login UI (hidden secret entry, arrow-key picker, browser handoff for OAuth), moved from the nax CLI so `nax-agent login` shares it (S5-4).
- `loginProviderIds()`: the providers `runLogin` can log in to (S5-4).
- `displayToolInput` and `toolResultPreview`: the live tool-display masking, for replaying stored transcripts (S5-1).
- `answerable?: false` on the `approval_requested` and `question` session events, set for profile auto-decisions and noted questions (S5-2).
- `carryHistoryAcrossModels` (`nativeBackend` option and `OpenSessionOpts`): keep a session's history across a model change; each assistant message records its origin model (S5-3).

## [0.3.1] - 2026-10-07

### Added

- `attachTurnSpend(err, spend)` and `readTurnSpend(err)`, with the `FailedTurnSpend` type: a backend attaches the spend a failed turn had already incurred to the error it throws, and the turn's `turn_end` reports it (#2367).
- `OpenSessionOpts.toolAudit` (optional `{ dir, header }`): the tool-audit ledger location and header for an S1 adapter that writes its own ledger (nax's ACP adapter, S4b). nax-agent itself does not read it; native takes its sink from coding-tool support.
- `resultBytes` (optional) on the `tool_result` turn event: the UTF-8 byte length of the full result before the preview cap.
- `ToolAuditHeader` is exported from the package entry.
- `AGENT_SESSION_RATE_LIMITED` error code (a backend's rate-limited turn).
- `tool_progress` turn event: a running tool's liveness beat (no content), for S1 callers such as nax's idle watchdog. The session facade does not forward it as a session event.

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
