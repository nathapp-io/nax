# SPEC: review e684f920 fixes: ACP settings, resume and turn-dispatch races

## Summary

Four fixes in `packages/nax-agent-acp` from the verified code review of `e684f9205` (findings 1, 4, 5 and 6):

1. **Settings mutations run one at a time (finding 1, P1).** `set_mode` and `set_config_option` on one session are serialized. Each one computes its target settings from the session's metadata as it stands when its turn in the queue comes, so an accepted permission downgrade is never undone by a model change that was waiting on credentials.
2. **A resume re-checks the session under its lock (finding 5).** A resume that read the metadata before a delete removed it fails with the not-found error instead of opening the deleted id and recreating its metadata.
3. **A turn cancelled before its first dispatch sends no prompt (finding 4).** When the turn's signal is already aborted at the moment the first `session/prompt` would be sent, nothing is sent and the turn ends `cancelled`.
4. **Instruction delivery is persisted (finding 6).** The transcript document's ACP record stores whether the agent has received the session instructions. A resume trusts that record; a document without it keeps today's turn-marker rule.

## Motivation

The review (`review-e684f920/REVIEW.md`) confirmed each defect at `e684f9205`:

- **Finding 1.** `setMode` and `setConfigOption` compute `next` from `settingsOf(entry.meta)` and then call `applySettings`, which calls `switchTo`. A model change awaits `ensureCredentials(next.model)` before it reopens the session. A mode change does not await credentials, so a `set_mode` to `read` sent during that wait completes and persists `read`. When the model change resumes, it reopens with its stale `next.mode` (`full`) and writes `mode: next.mode` into the metadata. The probe observed `full → read → full`, with both requests succeeding.
- **Finding 5.** `openStored` (`registry-open.ts`) reads the metadata, then `openEntry` awaits `ensureCredentials` and `acquireLock`. A `delete` of the closed session in that window takes the lock, removes the transcript and metadata, and releases. The pending resume then acquires the lock, opens the stale id, and its next prompt's `recordTurn` writes the metadata again. The prior conversation stays deleted.
- **Finding 4.** `runTurn` emits `turn_start` and awaits `markTurn(..., "running")`; `sendTurn` awaits `liveFor`; `promptOnce` then calls `state.link.prompt` without consulting the signal. A cancel during those awaits reaches the agent as `session/prompt` followed by `session/cancel`.
- **Finding 6.** `openBackend` sets `instructionsSent: ctx.resume?.doc.turn !== undefined`. A first turn rejected locally (`ACP_IMAGE_INPUT_UNSUPPORTED`, thrown in `sendTurn` after the turn marker is written) sends zero prompts, yet the marker exists, so after close and explicit resume the first text prompt omits the instructions. Same-process retry is already correct because `onReceipt` sets the flag only on real receipt (#2364).

## Design

### Integration

Symbols this feature only reads:

- `packages/nax-agent-acp/src/server/session-config.ts`: `applyModeChange(settings, modeId)`, `applyConfigChange(settings, configId, value, tiers)`, `sameSettings`.
- `packages/nax-agent-acp/src/server/registry-open.ts`: `settingsOf(meta)` (imported by `registry.ts`).
- `packages/nax-agent-acp/src/server/server-session.ts`: `ServerSession.switchTo` sets `running = true` synchronously and refuses an overlapping call with `turnInProgress()`.
- `packages/nax-agent-acp/src/server/errors.ts`: `unknownSession(sessionId)` → `RequestError.resourceNotFound(sessionId)`.
- `packages/nax-agent-acp/src/server/registry.ts`: `recordTurn(sessionId, prompt, costUsd)`, `delete(sessionId)` (closes an open entry, else requires `hasMeta`, then takes the lock and removes transcript and metadata).
- `packages/nax-agent-acp/src/client/race.ts`: `race(pending, { signal })` resolves `{ kind: "aborted" }` at once for an already-aborted signal.
- `packages/nax-agent-acp/src/client/turn.ts`: `abortReason(signal)`, `NO_RESPONSE_SPEND`, `unansweredSpend(carried)`, `cancelTurn`; `attachTurnSpend` is imported there from `@nathapp/nax-agent`.
- `packages/nax-agent/src/session/agent-session-turn.ts`: `runTurn` (emits `turn_start`, awaits `markTurn(running)`, calls `sendTurn`), `fromError(err, signal)` (maps an abort to `cancelled`).

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- `setMode` / `setConfigOption` in `createSessionRegistry` (`packages/nax-agent-acp/src/server/registry.ts`).
  - Baseline: each computes `next` from `settingsOf(entryOf(sessionId).meta)` immediately, then awaits `applySettings(sessionId, entry, next, ...)`. Two calls on one session interleave.
  - Target: the registry keeps a private `Map<string, Promise<void>>` of settings tails keyed by session id. A new private helper `serializeSettings<T>(sessionId, work: () => Promise<T>): Promise<T>` invokes `work` synchronously, in the same tick, when no tail is stored for the session (so an uncontended call runs up to its first await exactly as today); otherwise it chains `work` after the stored tail (ignoring the tail's rejection). It stores the muted new tail and deletes the map entry in a `finally` when it is still the stored tail. `setMode` and `setConfigOption` run their whole body inside it: `entryOf(sessionId)`, the `apply*Change(settingsOf(entry.meta), ...)` computation, `applySettings`, and (for `setConfigOption`) the returned `configOptions(next, options.tiers)`. So the second of two overlapping calls computes from the metadata the first one persisted. A rejected mutation does not block the next one. Behaviour change: at baseline the second of two overlapping calls on one session is refused with `turnInProgress()` once the first has entered `ServerSession.switchTo`; it now waits and runs. No existing test pins the refusal. Prompts are not serialized: a turn started during a held credential lookup still runs and still records its metadata, as today.
- `openEntry` (`packages/nax-agent-acp/src/server/registry.ts`) and `openStored` (`packages/nax-agent-acp/src/server/registry-open.ts`).
  - Baseline: `openEntry(meta, port, mcpServers)` trusts `meta`; `openStored` passes the metadata it read before any await.
  - Target: `openEntry` gains a fourth parameter `opts?: { readonly requireStored?: boolean }`. When `requireStored` is true, right after `acquireLock` resolves and inside the existing `try`, it calls `deps.storage.readMeta(meta.sessionId)`; only existence is checked (the open proceeds with the metadata `openStored` read). A `null` result throws `unknownSession(meta.sessionId)`, so the existing `catch` releases the lock before rethrowing (MCP has not been started yet). `openStored` passes `{ requireStored: true }` through `openAndReplay`; `create` does not. The `createReopen` deps type gains the parameter.
- `promptOnce` (`packages/nax-agent-acp/src/client/turn.ts`).
  - Baseline: calls `state.link.prompt(...)` first, then races it against the signal.
  - Target: before calling `state.link.prompt`, when `input.signal.aborted` is true, it builds `reason = abortReason(input.signal)`, attaches `unansweredSpend(carried)` with `attachTurnSpend`, and throws `reason`; no `session/prompt` and no `session/cancel` is sent. `runPromptTurn`'s denial-continuation check is unchanged (it already reads `!input.signal.aborted` with no await before the next dispatch).
- `TranscriptAcpRecord` (`packages/nax-agent/src/native/session/transcript-types.ts`).
  - Baseline: `{ agentSessionId; agent; agentVersion?; cwd; costUsd? }`.
  - Target: gains `readonly instructionsDelivered?: boolean` — whether the agent has received the session instructions. Absent means "not recorded" (a document written before this feature).
- `initialDoc` (`packages/nax-agent-acp/src/client/open.ts`).
  - Target: when the session is opened with non-empty `instructions`, the new document's `acp` record carries `instructionsDelivered: false`. A session opened without non-empty instructions (undefined or `""`) writes no `instructionsDelivered` field, and `saveDelivery` runs only when `ctx.instructions` is non-empty, so a later resume that supplies instructions keeps today's turn-marker rule.
- `Restore` and `storedSessionOf` (`packages/nax-agent-acp/src/client/resume.ts`).
  - Target: `Restore` gains `readonly instructionsDelivered?: boolean`, set from `doc.acp.instructionsDelivered` only when it is a boolean; any other value is treated as absent.
- `openBackend`, `AcpSession` and `sendTurn` (`packages/nax-agent-acp/src/client/backend.ts`).
  - Baseline: `instructionsSent: ctx.resume?.doc.turn !== undefined`.
  - Target: `instructionsSent: restore?.instructionsDelivered ?? ctx.resume?.doc.turn !== undefined` — a recorded value wins, and a document without the field keeps the turn-marker rule (user ruling 2026-11-24: legacy documents are assumed delivered). `AcpSession` gains `deliverySaved: boolean`, initially `instructionsSent`. In `sendTurn`'s `finally`, after `saveBaseline`, when `s.ctx.instructions` is non-empty and `s.instructionsSent && !s.deliverySaved`, a new `saveDelivery(s)` load-merges `acp: { ...doc.acp, instructionsDelivered: true }` into the stored document (skipping a document with no `acp` record, as `saveBaseline` does) and sets `deliverySaved`. Like `saveBaseline` it is best effort: a failure is logged with `warn("Could not save the ACP instruction delivery", sessionId)` and never fails the turn.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| The first of two queued settings mutations rejects | The second still runs, computing from the metadata as it then stands. Only the first caller sees the error. |
| A resume finds its metadata gone after taking the lock | It rejects with `unknownSession(sessionId)`, releases the lock, opens no session and writes no metadata. |
| The turn signal is aborted before the first dispatch | No `session/prompt` is sent; the turn ends `cancelled` with zero tokens. |
| Saving the delivery record fails | `Could not save the ACP instruction delivery` is logged at warn; the turn's result is unchanged; the stored value stays `false`; the next completed turn tries again. |
| A stored `instructionsDelivered` is not a boolean | Treated as absent: the turn-marker rule decides. |

## Out of Scope

- Findings 2, 3 and 7-13 of review e684f920 belong to the other three review-e684 features (chat, workflow-verification, pi-client).
- Revising the design rule in `docs/superpowers/specs/2026-10-07-acp-fix-bundle-2364-2366-2367-design.md` (section 4, "Initial value is unchanged") to describe the persisted delivery record is a manual edit made with this spec; no story edits it.
- Existing transcript documents are not migrated; a document without `instructionsDelivered` keeps the turn-marker rule.
- US-001 only: prompts are not serialized with settings mutations; a turn that starts while a settings mutation is queued is refused or allowed by the existing `entry.server.running` check, as today.
- US-001 only: the settings queue is per registry instance; mutations of one session from separate server processes are not coordinated.
- US-001 only: a `delete` that races an in-flight `openStored` before the open takes its lock is answered by the re-check under the lock; `delete` does not wait for or cancel the in-flight open.
- US-001 only: a close or delete of the session while a settings mutation is queued is not coordinated with the queue; the queued mutation rejects with `unknownSession` from `entryOf`.
- US-001 only: the resume re-check under the lock verifies only that the metadata still exists; a mode or model changed by another process between the pre-lock read and the lock is not picked up.
- US-002 only: an abort that arrives after the first `session/prompt` was sent keeps today's `session/cancel` plus grace behaviour.
- US-002 only: `liveFor` may still reconnect a crashed agent process for an already-aborted turn; only the prompt dispatch is guarded.
- US-003 only: a reconnect after an agent crash keeps the in-memory `instructionsSent` flag and does not re-read the delivery record.

## Stories

**US-001: settings mutations are serialized and a resume re-checks the session under its lock (findings 1 and 5).** Workdir: `packages/nax-agent-acp`. No dependencies. `setMode` and `setConfigOption` run through a per-session `serializeSettings` queue that computes each target from the current metadata. `openEntry` gains `requireStored`, which `openStored` sets, so a resume of a session deleted after its pre-lock read is refused.

**US-002: a turn cancelled before its first dispatch sends nothing (finding 4).** Workdir: `packages/nax-agent-acp`. No dependencies. `promptOnce` checks the signal before `state.link.prompt` and throws the abort reason with the carried spend.

**US-003: instruction delivery is persisted in the ACP record (finding 6).** Workdir: `packages/nax-agent-acp`. No dependencies. `TranscriptAcpRecord` gains `instructionsDelivered`; a new document records `false`; a completed receipt load-merges `true`; `openBackend` prefers the recorded value over the turn-marker rule.

### Context Files

**US-001**
- `packages/nax-agent-acp/src/server/registry.ts` — `setMode`, `setConfigOption`, `applySettings`, `switchTo`, `openEntry`, `delete`
- `packages/nax-agent-acp/src/server/registry-open.ts` — `createReopen`, `openStored`, `openAndReplay`
- `packages/nax-agent-acp/test/helpers/registry-setup.ts` — `setupRegistry` with `ensureCredentials`, `failOpens`, `opened`, `releases()`
- `packages/nax-agent-acp/test/unit/server/registry-races.test.ts` — the held-credentials pattern (`heldCredentials`) and `priced(costUsd)` script

**US-002**
- `packages/nax-agent-acp/src/client/turn.ts` — `runPromptTurn`, `promptOnce`, `unansweredSpend`
- `packages/nax-agent/src/session/agent-session-turn.ts` — `runTurn`, `markTurn`
- `packages/nax-agent-acp/test/helpers/in-memory-launch.ts` — `inMemoryAgent`, `callsTo`
- `packages/nax-agent-acp/test/unit/client/backend-images.test.ts` — facade-level `open` / `send` helpers over `createMemoryTranscriptStore`

**US-003**
- `packages/nax-agent-acp/src/client/backend.ts` — `openBackend`, `sendTurn`, `saveBaseline`, `AcpSession`
- `packages/nax-agent-acp/src/client/open.ts` — `initialDoc`
- `packages/nax-agent-acp/src/client/resume.ts` — `Restore`, `storedSessionOf`
- `packages/nax-agent-acp/test/unit/client/backend-resume.test.ts` — `resumeAgentSession` fixtures over a shared transcript store
- `packages/nax-agent-acp/test/unit/client/backend-images.test.ts` — the `ACP_IMAGE_INPUT_UNSUPPORTED` rejection fixture

### Creates

**US-001**
- `packages/nax-agent-acp/test/unit/server/registry-settings-queue.test.ts` — overlapping settings mutation tests and the resume-versus-delete test

**US-002**
- `packages/nax-agent-acp/test/unit/client/turn-cancel-before-dispatch.test.ts` — cancellation-before-dispatch tests

**US-003**
- `packages/nax-agent-acp/test/unit/client/backend-instruction-delivery.test.ts` — delivery-record tests

### Modifies

**US-001**

None. Sequential settings changes and sequential deletes behave as today; existing registry tests assert sequential behaviour.

**US-002**

None. An abort after dispatch keeps its current path, which the existing cancel and grace tests cover.

**US-003**
- `packages/nax-agent/src/native/session/transcript-types.ts` — `TranscriptAcpRecord` gains the optional `readonly instructionsDelivered?: boolean` field with a doc comment; this is a type-only change in the nax-agent package that the ACP backend's writes need, with no runtime change in nax-agent.

### Seams

- None across stories: each story changes code its own ACs drive through the production entry points (`registry.setMode`, `registry.setConfigOption`, `registry.resume`, `AgentSession.send`, `resumeAgentSession`).

## Acceptance Criteria

ACs marked **(control)** already pass on the baseline code and pin behaviour that must not regress; every other AC fails on the baseline.

### US-001

The "overlap fixture" below is: a registry from `setupRegistry` whose `ensureCredentials` resolves at once on its first call (the `create` open) and is held pending on its second call. A session is created and switched to mode `full` with `registry.setMode`. `registry.setConfigOption(sessionId, "model", "anthropic/claude-haiku-4-5")` is then started and parks on the held lookup, and `registry.setMode(sessionId, "read")` is started while it is parked.

1. [integration] In the overlap fixture, after the held lookup is released, both `registry.setConfigOption` and `registry.setMode` resolve, and `storage.readMeta(sessionId)` returns `mode` `read` and `model` `anthropic/claude-haiku-4-5`.
2. [integration] In the overlap fixture, after release, the last `openSession` request recorded in `opened` has `profile` `read` and `model` `anthropic/claude-haiku-4-5`.
3. [integration] In the overlap fixture, while the lookup is still held, `registry.setMode` has not added any request to `opened`; after release, the request for the model switch is recorded before the request for the mode switch.
4. [integration] (control) In the overlap fixture, a prompt with the `priced(0.25)` script sent through `registry.get(sessionId).prompt` while the lookup is held completes before release, and after both calls resolve `storage.readMeta(sessionId)` returns `costUsd` 0.25.
5. [integration] (control) Run one after the other on a created session (`registry.setConfigOption` to `anthropic/claude-haiku-4-5` awaited, then `registry.setMode(sessionId, "read")`), `storage.readMeta(sessionId)` returns `mode` `read` and `model` `anthropic/claude-haiku-4-5`.
6. [integration] With `setupRegistry` and `failOpens: [2]` (the create is open 1, the failing switch open is 2, its restore is 3), `registry.setMode(sessionId, "full")` and `registry.setMode(sessionId, "read")` started in the same tick on a created session settle with the first rejecting and the second resolving, and `storage.readMeta(sessionId)` returns `mode` `read`.
7. [integration] (control) An uncontended `registry.setConfigOption(sessionId, "model", "anthropic/claude-haiku-4-5")` on a created session calls `ensureCredentials` for the new model in the same tick it is called, before any await.
8. [integration] A session is created and closed with `registry.close`; `registry.resume(sessionId, input)` is started with `ensureCredentials` held on its call (call 2; the create is call 1), and the test awaits a signal that the held call was entered (so `readMeta` has resolved) before `registry.delete(sessionId)` is called and resolves. After release, the `registry.resume` call rejects with the same error code that `registry.resume` of a never-created id rejects with.
9. [integration] In the resume-versus-delete case of AC8, `openSession` is not called for the `registry.resume`.
10. [integration] In the resume-versus-delete case of AC8, after the `registry.resume` settles, `releases()` equals 3 (the close, the delete and the resume's own lock).
11. [integration] (control) In the resume-versus-delete case of AC8, `storage.hasMeta(sessionId)` is false after the `registry.resume` settles.
12. [integration] (control) `registry.resume` of a closed session that was not deleted resolves with the stored mode and model.
13. [integration] (control) `registry.delete` of a closed session with no resume in flight removes its metadata, and a later `registry.resume` of that id rejects with the not-found error code.

### US-002

The "held-marker fixture" below is: a session opened through `createAgentSession` over `acpBackend` and an `inMemoryAgent`, with a transcript store wrapping `createMemoryTranscriptStore` whose `markTurn` for the state `running` waits on a held promise. `AgentSession.send("look")` is iterated; on its `turn_start` event `AgentSession.cancel()` is called, and then the held `markTurn` is released.

1. [integration] In the held-marker fixture, the `inMemoryAgent` receives zero `session/prompt` requests (`callsTo("session/prompt")` is empty).
2. [integration] In the held-marker fixture, the `inMemoryAgent` receives zero `session/cancel` notifications.
3. [integration] (control) In the held-marker fixture, the terminal `turn_end` event of `AgentSession.send` has status `cancelled`.
4. [integration] In the held-marker fixture with the `inMemoryAgent` scripted to answer a prompt with usage of 7 input and 3 output tokens, the terminal `turn_end` event reports `inputTokens` 0 and `outputTokens` 0.
5. [integration] (control) When `AgentSession.cancel()` is called after the `inMemoryAgent` has received the `session/prompt` and it answers `cancelled` within the grace, it received exactly one `session/prompt` and one `session/cancel`, and the turn's status is `cancelled`.
6. [integration] (control) After the held-marker fixture's cancelled turn, a second `AgentSession.send("again")` on the same session adds exactly one `session/prompt` to `callsTo("session/prompt")` and ends `completed`.

### US-003

The "delivery fixture" below is: a session opened through `createAgentSession` over `acpBackend` and an `inMemoryAgent` that advertises `session/resume` (the `RESUMABLE` capabilities of `backend-resume.test.ts`) and whose prompt capabilities exclude images, with `instructions` `RULES` and one `createMemoryTranscriptStore` shared by the open and any later `resumeAgentSession`.

1. [integration] In the delivery fixture, right after `createAgentSession` resolves, the stored document's `acp.instructionsDelivered` is `false`.
2. [integration] In the delivery fixture, a first `AgentSession.send("look", { images: [img] })` ends `errored` with `ACP_IMAGE_INPUT_UNSUPPORTED`, and afterwards the stored `acp.instructionsDelivered` is still `false`.
3. [integration] In the delivery fixture, after that rejected image turn, `close()` and `resumeAgentSession` with the same store and `instructions` `RULES`, the first `AgentSession.send("next")` reaches the `inMemoryAgent` as a `session/prompt` whose text block is `RULES\n\nnext`.
4. [integration] In the delivery fixture, after a first text `AgentSession.send` that the `inMemoryAgent` answers with message content, the stored `acp.instructionsDelivered` is `true`.
5. [integration] (control) In the delivery fixture, after that completed text turn, `close()` and `resumeAgentSession`, the next `AgentSession.send("next")` reaches the `inMemoryAgent` with text block `next`.
6. [integration] (control) A stored document with a valid `acp` record (`agentSessionId`, `agent`, `cwd`) that has no `instructionsDelivered` field and which carries a turn marker, resumed through `resumeAgentSession` with `instructions` `RULES`, sends the next `AgentSession.send("next")` with text block `next`.
7. [integration] (control) A stored document with a valid `acp` record that has no `instructionsDelivered` field and no turn marker, resumed through `resumeAgentSession` with `instructions` `RULES`, sends the next `AgentSession.send("next")` with text block `RULES\n\nnext`.
8. [integration] A stored document with a valid `acp` record whose `instructionsDelivered` is `false` and which carries a turn marker, resumed through `resumeAgentSession` with `instructions` `RULES`, sends the next `AgentSession.send("next")` with text block `RULES\n\nnext`.
9. [integration] In the delivery fixture with a transcript store whose `save` throws only for the write that carries `instructionsDelivered: true`, once, the first completed text turn logs a warn line `Could not save the ACP instruction delivery` on the logger installed with `setAgentLogger` (from `@nathapp/nax-agent`), ends `completed`, and leaves the stored `acp.instructionsDelivered` `false`.
10. [integration] In the save-failure case of AC9, after a second completed `AgentSession.send`, the stored `acp.instructionsDelivered` is `true`.
11. [integration] (control) A session opened through `createAgentSession` with no `instructions` writes a document whose `acp` record has no `instructionsDelivered` field.
12. [integration] A session opened through `createAgentSession` with `instructions` `""`, after a first text `AgentSession.send` the `inMemoryAgent` answers with message content, leaves a stored `acp` record with no `instructionsDelivered` field.
