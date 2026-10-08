# S5: ACP server (`nax-agent` binary over the S3 facade)

**Status:** design approved section by section in brainstorm 2026-10-08. Not yet final-reviewed.

**Master plan:** `nax-agent-master-plan.md` (maintainer workspace), row S5; decisions D24 (ACP server = S5, ACP stays in the nax-agent family) and D25 (official `@agentclientprotocol/sdk`, `./server` reserved in `@nathapp/nax-agent-acp`).

**Baseline:** main `cfab34e07` (nax v0.83.7). `@nathapp/nax-agent` and `@nathapp/nax-agent-acp` 0.3.1 released; both are `"private": true` in the workspace and publish from a staged manifest. `@agentclientprotocol/sdk` 1.7.0 installed (`~1.7.0`). `packages/nax-agent-acp/src/server/index.ts` is an empty `export {}` reserved for S5.

## 1. Goal

Ship a `nax-agent` binary that speaks the Agent Client Protocol (ACP) over stdio and drives the S3 facade (`createAgentSession` / `resumeAgentSession`), so editors (Zed and other ACP clients) and headless clients (acpx, scripts, koda) can use nax-agent's native coding agent.

**Primary consumer: editors first; headless clients must also work** (user ruling 2026-10-08).

**Done means:**
- Zed drives a session end to end: streamed text and thinking, tool calls with diffs, a permission prompt that applies or rejects an edit, cancel, mode and model switch, close the editor, reopen the thread with its history.
- `acpx nax-agent` (or an `agents{}` entry) runs a prompt headless with `--approve-all`, reconnects, and continues the same session.

## 2. Rulings (user, brainstorm 2026-10-08)

| # | Question | Ruling |
|---|---|---|
| R1 | Primary consumer | Editors first, headless supported. |
| R2 | Where tools execute | Locally, in-process, under nax-agent's profile, policy and sandbox. Edits are reported to the client as `diff` tool-call content. The server does NOT delegate to the client's `fs/*` or `terminal/*` methods. |
| R3 | Default mode for a new session | `ask` (every mutating action raises a permission request). |
| R4 | Credentials and config | Reuse `~/.nax` (same credential store as `nax auth login`), AND advertise ACP `authMethods` so an editor can start a login. |
| R5 | Packaging | `nax-agent` bin in `@nathapp/nax-agent-acp`; implementation behind the reserved `./server` export. No dependency on the nax CLI package. |
| R6 | Persistence | File-backed sessions; `session/load`, `session/list`, `session/resume`, `session/close`, `session/delete` supported. |
| R7 | Client-supplied `mcpServers` | Ignored with a notice in v1; bridged in a later, final S5 slice (S5-5). |

Approach chosen: a **thin adapter over the S3 facade**. Rejected: bridging below the facade at the `SessionBackend` level (duplicates S3's approval, transcript, and resume logic); a hand-rolled JSON-RPC transport (D25 settled the official SDK).

## 3. Architecture

```
editor / acpx ──stdio NDJSON──► bin/nax-agent  (@nathapp/nax-agent-acp)
                                  │
                                  ▼
                       src/server/  (./server export)
  ┌──────────────┬──────────────────┬──────────────────┬──────────────┐
  │ connection   │ session registry │ event translator │ config/auth  │
  │ agent() app, │ ACP id ->        │ SessionEvent ->  │ ~/.nax read, │
  │ initialize,  │ ServerSession    │ SessionUpdate    │ authMethods, │
  │ capabilities │ (wraps one       │ (pure functions) │ credentials  │
  │              │  AgentSession)   │                  │ slot         │
  └──────────────┴──────────────────┴──────────────────┴──────────────┘
                                  │
                                  ▼
       @nathapp/nax-agent: createAgentSession / resumeAgentSession
         + nativeBackend + createFileTranscriptStore(<sessionsDir>)
```

### 3.1 Units

| Unit | Responsibility | Depends on |
|---|---|---|
| `bin/nax-agent.ts` | Argument parsing, subcommand dispatch (`acp` default, `login`, `--version`), signal handling. | `server/cli`, `server/config` |
| `server/connection.ts` | Builds the SDK `agent({ name })` app, wires `ndJsonStream(stdout, stdin)`, registers handlers, answers `initialize`. Uses the builder API, not the deprecated `AgentSideConnection`. | registry, config, auth |
| `server/registry.ts` | Map of ACP session id -> `ServerSession`; open, load, resume, list, close, delete; shutdown of all sessions. | storage, `ServerSession` |
| `server/server-session.ts` | Owns one `AgentSession` plus its mode, model and `bashApproval`; runs `prompt` via `send()`, forwards events through the translator, handles permission and elicitation round trips, `cancel`, close-and-resume on mode/model change. | translator, nax-agent facade |
| `server/translate/*.ts` | Pure mapping from S3 `SessionEvent` to ACP `SessionUpdate` (§4), tool-kind table, diff building, stop-reason mapping, transcript replay (§5.4). No I/O except the Write diff's old-text read, which is injected. | none |
| `server/storage.ts` | Session metadata file, lockfile, directory scan for `list`. | node:fs |
| `server/config.ts` | Option resolution (flag > env > `~/.nax/config.json` > default), zod-validated reader of the `~/.nax` subset (§6.2). | zod |
| `server/auth.ts` | `authMethods` advertisement, `authenticate` check, `login` subcommand over `runLogin`. | nax-agent auth exports |
| `server/errors.ts` | Mapping of failures to SDK `RequestError` (§7). | SDK |

Source files stay under the repo's 600-line cap; tests under the 800-line cap.

### 3.2 Turn flow

1. `session/prompt` arrives. `ServerSession` rejects it if a turn is already running (`invalid_request`, "turn in progress").
2. Prompt content blocks are flattened to one text message: `text` blocks verbatim; `resource` (embedded) blocks inlined as a fenced block headed by the URI; `resource_link` blocks inlined as the URI only. Image and audio blocks are not advertised and are rejected with `invalid_params` if sent.
3. `session.send(message)` is iterated. Each event goes through the translator; resulting updates are sent with `sessionUpdate`. Permission and question events start a client round trip (§4.3) without blocking event forwarding.
4. On `turn_end`, the prompt request is answered (§4.4). `updatedAt` (and on the first turn, `title`) is written to the metadata file.

### 3.3 Mode and model changes

S3 fixes the profile, model, and `bashApproval` at session creation. A change between turns closes the `AgentSession` and calls `resumeAgentSession` on the same transcript with the new options. A change while a turn is running is rejected (`invalid_request`, "turn in progress"). The metadata file is updated only after the resume succeeds; on failure the old session is reopened with the old options and the error is returned.

## 4. Event mapping

### 4.1 Streamed events

| S3 `SessionEvent` | ACP `session/update` | Notes |
|---|---|---|
| `turn_start` | none | |
| `text_delta` | `agent_message_chunk` (text) | Streamed live. |
| `thinking_delta` | `agent_thought_chunk` (text) | |
| `stream_reset` | `notice` (severity info, title "Response restarted") | ACP cannot retract chunks already sent; the client sees the partial text followed by the retried text. Buffering per round was rejected (kills live streaming). |
| `tool_call` | `tool_call`, status `in_progress` | `toolCallId` = `callId`; `kind` per §4.2; `rawInput` = input; `title` = short summary (`Edit src/foo.ts`, `Bash: <first 60 chars>`); `locations` = `[{ path }]` for Read, Write, Edit, Delete; `content` = diff for Edit and Write (§4.2). |
| `tool_result` | `tool_call_update`, status `completed` (or `failed` when `isError`) | `content` = preview as a text block; the diff is repeated for Edit and Write. |
| `usage` | `usage_update` | `used` = input + output tokens of the round; `size` = the model's context window from the catalog (or `catalogOverrides`); `cost` = `{ amount: costUsd, currency: "USD" }`; `costSource` in `_meta.naxAgent.costSource`. When the context window is unknown, no `usage_update` is sent for that round (`size` is required); the turn total still reaches the prompt response. |
| `compaction` | `compaction_update` | One `compactionId` per event; status completed; reason in `_meta`. |
| `approval_requested` | §4.3 | |
| `approval_resolved` | §4.3 | |
| `question` | §4.3 | |
| `turn_end` | the `session/prompt` response (§4.4) | Always the last event. |

### 4.2 Tool kinds and diffs

| Tool | ACP `ToolKind` |
|---|---|
| Read, ScratchpadRead, ScratchpadList | `read` |
| Glob, Grep | `search` |
| Edit, Write, ScratchpadWrite | `edit` |
| Delete | `delete` |
| Bash, RunCommand, Git, GitCommit | `execute` |
| RequestCapability, embedder tools, anything unknown | `other` |

Diffs are built from the tool **input** (available at approval time, before execution):
- **Edit:** `{ type: "diff", path: <absolute>, oldText: old_string, newText: new_string }`.
- **Write:** `{ type: "diff", path: <absolute>, oldText: <current file content, or null if the file does not exist>, newText: content }`. The current content is read from disk at `tool_call` time through an injected reader; files above 1 MiB get `oldText: null` and a `_meta.naxAgent.oldTextOmitted: "too-large"` marker.
- Paths in tool inputs are repository-relative; the server resolves them against the session `cwd`.

**Known limitation:** S3 redacts `tool_call.input` best-effort (`session/turn-event.ts`). A diff can show a redacted placeholder where the file holds a secret. Display only; execution is unaffected. Accepted for v1; no unredacted channel is added to S3.

### 4.3 Approvals and questions

**Approvals.** `approval_requested` whose decision needs a human (profile `ask`, or `gated` bash escalation):
- Sent as `session/request_permission` with `toolCall` = the matching `ToolCallUpdate` (by `callId`; title, kind, content incl. diff, `command` for bash) and options `allow_once`, `allow_always`, `reject_once`, `reject_always`.
- **Session memory:** `allow_always` / `reject_always` are remembered per tool name (per bash command prefix for `execute` tools: the first word of the command) for the life of the `ServerSession`, in memory only. A later request matching a remembered decision is answered by the server without asking the client.
- The selected option maps to `answer(requestId, { decision: "allow" | "deny" })`.
- Client outcome `cancelled` -> deny.
- `expiresAt` (S3's `approvalTimeoutMs`) reached first -> the server stops waiting, S3 records the timeout deny; the pending client request is abandoned and its late response ignored.

`approval_requested` / `approval_resolved` decided by the profile (`decidedBy` not human): no permission request. A deny marks the tool call `failed` with the reason as content; an allow adds nothing.

**Questions.** `question` events:
- If the client declared elicitation support in `initialize`: `elicitation/create` with one required free-text field `answer` and the question as the message. `accept` -> `answer(requestId, { text })`; `decline` / `cancel` -> `answer(requestId, { text: "The user declined to answer." })`.
- Otherwise: a `notice` (severity warning) carrying the question text, then immediately `answer(requestId, { text: "No answer available: this client cannot answer questions. Proceed with your best judgement." })`. The agent is never left waiting for `expiresAt` (default 10 minutes), which matters for headless clients. Documented in the README.
- A session cancel while an elicitation is open cancels it; S3's cancel settles the question.

**Cancel.** `session/cancel` calls `session.cancel()`, settles every open permission request as deny, and cancels every open elicitation. The prompt then resolves with `stopReason: "cancelled"`.

### 4.4 Turn end

| `turn_end.status` | `session/prompt` response |
|---|---|
| `completed` | `{ stopReason: "end_turn", usage }` |
| `cancelled` | `{ stopReason: "cancelled", usage }` |
| `timed_out` | `{ stopReason: "max_turn_requests", usage }`, preceded by a `notice` naming the turn timeout (`turnTimeoutSeconds`) |
| `errored` | JSON-RPC `internal_error` with `data: { code, message }` from `turn_end.error` (already redacted by S3) |
| `interrupted` | never returned from a prompt; surfaced on `session/load` (§5.3) |

`usage` = the turn's cumulative `turn_end.usage` (input, output, cache read, cache write tokens) mapped to the SDK `Usage` shape.

## 5. Sessions and persistence

### 5.1 Storage layout

Default directory: `<configDir>/.agent-server/sessions/` (configDir defaults to `~/.nax`; the dot prefix avoids colliding with nax's per-project directories under `~/.nax`). Overridable with `--sessions-dir`.

| File | Owner | Content |
|---|---|---|
| `<id>.transcript.json` | S3 `createFileTranscriptStore` | Unchanged S3 `TranscriptDoc`. |
| `<id>.session.json` | server | `{ schemaVersion: 1, sessionId, cwd, mode, model, bashApproval, title, createdAt, updatedAt }`, written atomically (temp + rename). `title` = first prompt text truncated to 80 chars; null until the first prompt. |
| `<id>.lock` | server | Created with exclusive create (`wx`); content = `{ pid, startedAt }`. Removed on close. |

**Lock rule.** Opening a session (new, load, resume) takes the lock. An existing lock whose pid is not alive (`process.kill(pid, 0)` throws `ESRCH`) is stale and taken over. A live lock fails the request with `invalid_request` "session in use by pid N". Two server processes on one session would otherwise race on the transcript.

### 5.2 Capabilities advertised in `initialize`

- `loadSession: true`
- `sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} }`
- `promptCapabilities: { embeddedContext: true, image: false, audio: false }`
- `authMethods`: §6.3
- `agentInfo: { name: "nax-agent", version }`
- Modes: `none`, `read`, `ask`, `full` (names and one-line descriptions from the S3 profile docs), returned on `session/new` / `load` / `resume`.
- Config options on `session/new` / `load` / `resume`: `model` (select, §6.2) and `bashApproval` (select: `gated`, `escalate`, `raw`).

### 5.3 Methods

| ACP method | Behaviour |
|---|---|
| `session/new` | Validate `cwd` absolute (`invalid_params` otherwise). New uuid; take lock; write metadata with mode = resolved default (`ask` unless configured), model = resolved default, `bashApproval` = resolved default (`gated`); `createAgentSession({ backend: nativeBackend({ model, bashApproval, catalogOverrides }), profile: mode, workdir: cwd, transcriptStore, sessionId })`. Non-empty `mcpServers` -> one `notice` "MCP servers are not supported yet; ignored" (until S5-5). |
| `session/load` | Read metadata (`resource_not_found` if absent); take lock; `resumeAgentSession` with the stored mode, model, `bashApproval`; replay the transcript (§5.4) before responding; if `lastTurn === "interrupted"`, end the replay with a `notice` (warning) "The previous turn was interrupted". |
| `session/resume` | As `load` without replay (acpx reconnect path). |
| `session/list` | Scan `*.session.json`; filter by `cwd` when given; sort by `updatedAt` desc (`createdAt` when null); page size 50, cursor = opaque base64 offset. Unreadable metadata files are skipped and logged. |
| `session/close` | Cancel a running turn, `close()`, release the lock; files kept. Unknown id -> `resource_not_found`. |
| `session/delete` | Close if open, then remove the three files. |
| `session/set_mode` | §3.3; on success send `current_mode_update`. |
| `session/set_config_option` | `model` or `bashApproval`; §3.3; on success send `config_option_update`. A model id not in the option list -> `invalid_params` listing the valid ids (strict, as D2-b). `bashApproval: raw` with mode `ask` -> `invalid_params` (S3 requires `gated` for `ask`). |
| `session/prompt` | §3.2. |
| `session/cancel` | §4.3 (notification; no response). |

A loaded or resumed session restores the stored mode and model, not the defaults.

### 5.4 Transcript replay on load

Walk `TranscriptDoc.messages` in order:

| Message content | Replayed as |
|---|---|
| user text | `user_message_chunk` |
| assistant text | `agent_message_chunk` |
| assistant thinking | `agent_thought_chunk` |
| assistant tool call + its tool result | one `tool_call` already in final status (`completed` / `failed`), kind and title as §4.2, result truncated to the live preview cap; Edit carries its diff; Write carries no diff (the past old text is unrecoverable) |
| system / instruction content | not replayed |

### 5.5 Shutdown

On stdin end, SIGINT or SIGTERM: cancel every running turn, wait up to 5 s per session for `turn_end`, `close()` every session, release every lock, exit 0. A process killed harder leaves S3's running turn marker; the next `load` reports `interrupted` and the stale lock is taken over.

## 6. Configuration and auth

### 6.1 Binary

| Invocation | Behaviour |
|---|---|
| `nax-agent` / `nax-agent acp` | ACP server on stdio. |
| `nax-agent login <provider>` | Interactive login on the terminal via `runLogin(provider, interaction)`; writes to the `~/.nax` credential store. |
| `nax-agent --version` | Prints the package version. |

Flags (each also settable as `NAX_AGENT_<FLAG>` in SCREAMING_SNAKE, since editors often set only env): `--config-dir` (default `~/.nax`), `--sessions-dir`, `--model`, `--mode`, `--bash-approval`. Precedence: flag > env > `~/.nax/config.json` > built-in default.

### 6.2 `~/.nax/config.json` subset

A local zod reader (no dependency on nax's config loader, per R5) reads only:
- `models.native.balanced` -> default model. String form (`"provider/model[effort]"`) or object form (`{ provider, model, contextWindow }`); the object form's fields become `catalogOverrides`.
- `models.native.{fast, balanced, powerful}` -> the `model` config option's values, labelled by tier with the model id as description; plus the session's current model when it is none of these (e.g. set by `--model`).
- New optional block `agentServer: { defaultMode?, bashApproval?, sessionsDir? }`.

All other keys are ignored. Missing file or a validation failure -> built-in defaults plus one stderr warning. No resolvable model -> `session/new` fails `invalid_params` "no model configured: set models.native.balanced or --model".

The bin calls `configureCredentials({ configDir })` at startup so the native backend reads the same credential file as nax.

The new `agentServer` block needs no change in nax: nax's root config schema uses zod's default strip mode, so an unknown top-level key is dropped, not rejected. nax does not read it.

### 6.3 Auth

- **Terminal auth methods** are advertised only when the client's `initialize` declares `clientCapabilities.auth.terminal: true`: one method per provider that both `runLogin` supports and appears in the configured tier models, `{ id: "login-<provider>", name: "Log in to <provider>", type: "terminal", args: ["login", "<provider>"] }`.
- **`authenticate(methodId)`** checks the credential store (`listStoredProviders`) for that provider: present -> success; absent -> `auth_required`.
- **No agent-type auth in v1** (driving OAuth or key entry over elicitation; editor support is uneven).
- A prompt that fails with `CREDENTIALS_NOT_CONFIGURED` or a provider authentication error maps to `auth_required`, so editors start their login flow. The error message names `nax-agent login <provider>` and `nax auth login` for clients without terminal auth.

### 6.4 Logging

stderr only, through `setAgentLogger`; level `info`, `debug` with `NAX_AGENT_LOG=debug`. stdout carries protocol frames only.

## 7. Errors

| Situation | Error (SDK `RequestError`) |
|---|---|
| Relative `cwd`, unknown mode, unknown model, unsupported content block, `raw` with `ask` | `invalidParams`; model errors list valid ids |
| Unknown session id | `resourceNotFound` |
| Prompt, mode or model change while a turn runs | `invalidRequest` "turn in progress" |
| Live lock held by another process | `invalidRequest` "session in use by pid N" |
| Missing or rejected credentials | `authRequired` |
| Turn `errored` | `internalError` with `{ code, message }` from `turn_end.error` |
| Unreadable transcript or metadata, unknown `schemaVersion` | `internalError` on load; files are never deleted or rewritten |
| Unexpected exception in a handler | Logged with stack to stderr; client gets `internalError` with the message only; the process keeps serving other sessions |

Invariants: one session's failure never terminates the process; stdout carries only protocol frames; no permission request or elicitation stays open after cancel, timeout, or close.

## 8. Testing

- **Translator unit tests** (table-driven, one row per §4 mapping): tool kinds; Edit diff; Write diff with an existing file, a new file, and an over-1-MiB file; every stop reason; elicitation vs. fallback notice; replay of each message kind.
- **Server tests over an in-memory connection:** an SDK client connection linked to the server through paired streams, with a scripted fake `SessionBackend` underneath (no model calls). Cases: new -> prompt -> stream -> end; permission allow, deny, `allow_always` reuse, timeout; cancel mid-turn and with an open permission request; mode and model switch, rejected mid-turn, failed resume restoring the old session; load with replay and the interrupted notice; resume; list with cwd filter and paging; close and delete; lock contention and stale-lock takeover; `auth_required` mapping; the MCP notice.
- **Config and CLI tests:** precedence (flag > env > file > default); both model forms; invalid file fallback; `authMethods` only with `auth.terminal`; `login` against a stubbed `runLogin`.
- **stdout purity:** spawn the real bin, run a scripted session, assert every stdout line parses as a JSON-RPC frame.
- **Node lane:** extend `test/node/pack-smoke.test.ts` so the packed tarball's `nax-agent` bin starts under Node and answers `initialize`.
- **API surface:** update `api/nax-agent-acp.api.txt` for the `./server` exports (CI gate).
- **Live checks (each needs explicit approval at launch):** a billed acpx smoke (one short prompt with an edit, `--approve-all`, reconnect, load); a manual Zed walkthrough driven by the maintainer (stream, approve an edit, cancel, switch mode, restart, reopen).

## 9. Slices

One PR per slice, each off main.

| Slice | Contents |
|---|---|
| S5-0 | Package wiring: `bin` in the package and staged manifest; CLI flags and env; `~/.nax` config reader; `configureCredentials`; stderr logger; `initialize` with capabilities; stdout purity test; Node pack-smoke. |
| S5-1 | Translator (§4.1, §4.2, §4.4, §5.4 replay) as pure functions with table-driven tests. |
| S5-2 | Session core, in-memory sessions: `new`, `prompt`, `cancel`, permissions with session memory, elicitation, stop reasons, errors. |
| S5-3 | Persistence: metadata, lock, `load` with replay, `resume`, `list`, `close`, `delete`, `set_mode`, `set_config_option`. |
| S5-4 | Auth: `login` subcommand, terminal `authMethods`, `authenticate`, `auth_required` mapping. README section (Zed and acpx setup). Live acpx smoke and Zed walkthrough (approval). Release 0.4.0 of both agent packages (approval). |
| S5-5 | MCP bridge: connect client `mcpServers` (stdio, http) via `@modelcontextprotocol/sdk` and expose their tools as `EmbedderTool`s under the session profile's approval rules. Needs a short design addendum before planning. |

S5-0 to S5-4 deliver v1 without MCP.

**Version.** `@nathapp/nax-agent` and `@nathapp/nax-agent-acp` share one version (nax-agent's release helper bumps both; nax-agent publishes first). A new binary is treated as a minor bump: both packages 0.3.1 -> 0.4.0, released in the order nax-agent -> nax-agent-acp. (The patch-only rule applies to nax releases; all packages still go to 1.0.0 together after S6.) If the maintainer prefers patch-only for the agent packages too, it is 0.3.2.

## 10. Out of scope

- Delegating file or terminal operations to the client (`fs/*`, `terminal/*`) (R2).
- Agent-type ACP auth, `logout`, provider management methods.
- Image and audio prompt content.
- Session fork, additional directories.
- Persisting `allow_always` / `reject_always` across sessions.
- The koda chat UI (S6).
