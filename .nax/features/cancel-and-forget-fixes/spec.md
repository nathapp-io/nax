# SPEC: cancel-and-forget-fixes — cancels that stop what they started, a koda forget that survives a refusal, and two misleading messages

Closes: #2900, #2901, #2908, #2909

## Summary

A bundle of five defects: four close here, and part of #2905 is left for a follow-up. (1) `gitWithTimeout` kills only `git` on abort or timeout, and the helpers git started (`git-remote-https`, a credential helper, an ssh transport) keep running (#2900). (2) When a turn is aborted while a tool runs, the native session answers at once with `Tool "<name>" was abandoned: the turn ended.` and drops the tool's own result. For `nax-flow__send` that hides whether anything was pushed or created. The koda create request after the push also takes no signal, so an Esc during it still creates the flow (#2901). (3) With the koda memory provider, a forget that koda holds for approval (`202`) deletes the note from the mirror and records no approval. A rejected forget then leaves the note missing until `nax memory reset` (#2905, partly). (4) The `testScoped` `{{files}}` warning fires for turbo/nx orchestrator configs, where it is wrong (#2908). (5) The branch-review step line says `no findings` when the reviewer triaged deferred minors `fix-now`, and branch-fix then runs with no reason shown (#2909).

#2905 is related, not closed: making `nax memory status` report a refused koda proposal, and adding the `(forget pending)` marker to the session index for a koda-held forget, are deferred (see Out of Scope).

## Motivation

- #2900: a cancelled or timed-out push or fetch can keep doing network work after nax reported it cancelled. If the credential helper then returns, the push can even complete. A long `nax chat` session also gathers orphans. This was seen in the #2896 live re-check on `e147cdd10`.
- #2901: after Esc during the `nax-flow__send` push, the transcript says `abandoned: the turn ended`. The tool's own answer, `[chat] the turn was cancelled; nothing was pushed`, is the one that says nothing left the machine, and it is never shown. An Esc after the push and during `POST /fleet/flows` lets koda create the flow in the background while the chat says "abandoned". A retry then gets koda's `409 duplicate`.
- #2905: two checkouts linked to the same koda project disagree until the first one is reset. A forget the owner rejected silently loses the note from one checkout.
- #2908: every turbo/nx monorepo config gets a warning whose advice ("add `{{files}}`") cannot be followed: orchestrators take no test paths, and `resolveQualityTestCommands` never substitutes `{{files}}` into the root template in that mode.
- #2909: someone watching a run reads "no findings" and then sees a branch-fix session start with no reason given. The reason (`branch fix: 12 item(s): M1, ...`) exists only in `ledger.md`, as a `NO_MIRROR` note.

## Design

### Approach

**#2900, group kill.** `gitWithTimeout` spawns git with `detached: true`, which makes the git pid the leader of a new process group, so a group kill reaches every helper git spawned. The kill does two things in order: `_gitDeps.killProcessGroup(proc.pid, "SIGKILL", { singleProcessFallback: false })`, then `proc.kill("SIGKILL")` (each in its own try). The direct `proc.kill` still reaches git where groups do not exist (Windows, where `process.kill(-pid)` throws a non-`ESRCH` error that `killProcessGroup` reports as sent). It also keeps the existing `proc.killed` assertions true. `killProcessGroup` is the existing helper in `packages/nax-agent/src/internal/process-kill.ts`. It is reached through `_gitDeps`, so a test can observe it and no test sends a real signal. Precedent: `argvExec` in `packages/nax-agent/src/internal/argv-exec.ts` spawns `detached: true` and kills through `_argvExecDeps.killProcessGroup`. The early returns on the timeout and abort paths (no awaiting of drain promises) stay as they are. A detached git has no controlling terminal (`setsid`). nax's push paths already set `GIT_TERMINAL_PROMPT=0` (`NO_TERMINAL_PROMPT` in `packages/nax/src/utils/git.ts`, used by `finish/commit.ts` and `bot/git.ts`), and a credential helper or askpass program needs no terminal. What is lost is a prompt ssh would read from `/dev/tty` itself (a key passphrase, a host-key confirmation): that call now fails at once instead of waiting on the terminal.

Fact for the test stories: `makeSpawnResult` in `packages/test-kit/src/bun/spawn.ts` reports `pid: 4242` unless told otherwise. A test that fakes `_gitDeps.spawn`, reaches a kill, and leaves `_gitDeps.killProcessGroup` at its default would send a real `SIGKILL` to process group 4242 on the machine running the tests. Five existing tests reach a kill through a faked spawn. Two are in `nax-agent`: `test/unit/internal/git-env.test.ts` (the `gitWithTimeout abort signal (#2895)` describe) and `test/unit/tools/git-commit.test.ts` (the hung `check-ignore`). Three are in `nax`: `test/unit/utils/git.test.ts` (`does not stall when git subprocess hangs`), `test/unit/bot/git.test.ts` (`AC-3 forwards the deadline and kills a hung git`) and `test/unit/review/runner.test.ts` (the `getUncommittedFilesImpl — BUG-1 pipe-drain regression` suite, which shrinks `_gitDeps.gitTimeoutMs` to 50). `_gitDeps` is one object, re-exported by `packages/nax/src/utils/git.ts`, so a patch through either path reaches it.

**#2901 part 1, cancel grace.** This is opt-in per tool. `ProviderTool` gains `cancelGraceMs?: number`, and `adaptProviderTool` copies it onto the adapted `CodingTool` (`CodingTool.cancelGraceMs?: number`). `nativeBackend` builds a map from qualified tool name to grace for every provider tool that declares one, and passes it to `createSessionInteractionHandler` as `SessionInteractionDeps.cancelGraceByTool`. `runCodingTool` then composes the turn signal and the grace in this order:

1. The signal is already aborted when the call arrives: answer the generic abandoned outcome at once and never call the tool (unchanged).
2. The tool declares no grace (absent from the map): answer the generic abandoned outcome the moment the signal aborts (unchanged).
3. The tool declares a grace: when the signal aborts, wait up to the grace for the tool's own outcome. If it settles in time, that outcome is the answer, with the same handling as an unaborted call: `denied` maps to a denial, `error` throws, `ok` answers. Otherwise answer the generic abandoned outcome, and ignore the late settlement.

A declared grace is normalised before use: a non-finite value or one `<= 0` counts as no grace, and a value above `MAX_CANCEL_GRACE_MS = 10_000` counts as `10_000`. The grace timer is cleared on every settle path. Embedder tools (`invoke`) are unchanged.

**#2901 part 2, the koda create.** `KodaClient.post` gains an optional third argument `{ signal?: AbortSignal }`, and `KodaClient.get` is unchanged. In `request`, a given signal that aborts before the answer ends the call with a `NaxError` coded `MEMORY_KODA_ABORTED`, and aborts the fetch through the existing `cancel` controller. A signal already aborted when `post` is called rejects with the same error and never calls `fetch`. An answer that arrived before the abort is returned as usual. `createKodaFlow(connection, body, signal?)` passes the signal to `client.post`. In `flow-provider.ts`, `afterAllow` passes its signal to `createFlow`, which passes it to `createKodaFlow`. When the create rejects with `MEMORY_KODA_ABORTED`, the result is the failure `[chat] the turn was cancelled during the koda request; branch <branch> stays pushed and koda may have created the flow; check koda's flows before sending again (a duplicate send is refused with 409)`. The send tool declares `cancelGraceMs: FLOW_SEND_CANCEL_GRACE_MS` (`5_000`), so this answer, and the existing `[chat] the turn was cancelled; nothing was pushed`, reach the transcript.

**#2905, a koda-held forget.** Today, under `memory.writeMode: "direct"` (the CLI's mode comes from config; koda answers `202` whatever the local mode is), `forgetLocked` (`packages/nax-agent/src/memory/operations.ts`) deletes the note before the push. `handOverForget` and the drain's `applyPushed` (`delivery.ts`) then accept a `pending` answer without putting it back. The fix has two halves:

- nax-agent (generic): a forget the provider answers `pending` leaves the note in the mirror. On the hand-over path, `handOverForget` writes `previous` back with `restoreForgotten` when `writeMode` is `direct`. On the drain path, the note was deleted when the entry was queued and the entry holds no copy, so `applyPushed` rewinds that scope's pull cursor with the existing `rewindPullCursor(store, scope)` when the entry's `writeMode` is `direct`. A `proposal` entry never deleted its note, so it does not rewind. `rewindPullCursor` lives in `sync-drain.ts`, which already imports `applyPushed` from `delivery.ts`, so calling it from `delivery.ts` would be an import cycle, which `check-import-cycles` fails. It moves to a new leaf module, `packages/nax-agent/src/memory/pull-cursor.ts`, whose only imports are types. `sync-drain.ts` re-exports it, so `internal.ts` and nax's `host-writes.ts` import it unchanged. The same sync's pull then re-reads the scope in full and brings the provider's active row back. A forget answered `deleted` is unchanged.
- nax (koda): `KodaApproval` gains `kind?: "save" | "forget"`. An absent `kind`, and any `kind` value other than `"forget"`, reads as a save, so an existing file stays valid and an unknown value never makes the file unusable. An older nax that rewrites the file drops `kind`, which turns a forget record into a save record; that is accepted. `approvalOf` keeps it, and `record` replaces only the record with the same kind, scope and slug. `retire()` in `koda-provider.ts` records a `202` answer with `kind: "forget"` (approval id = `data.id` of the answer, client id = the request's `clientId`) before returning `pending`. A `202` without a string `data.id` is the provider's existing bad-response error. A `record` that rejects (for example `MEMORY_KODA_APPROVALS_READ_FAILED`) is logged as a warn and the forget still resolves `pending`. Koda has already opened the approval, so rejecting the push would queue a retry, and a retry's retire can answer `409`, which the provider reads as `deleted`. Without a record the note stays in the mirror unmarked, and the feed's tombstone still removes it if koda executes the forget. In `koda-pull.ts`, `resolveRecord` treats a forget record by koda's answer: open keeps it; executed drops it (the feed's retired-row tombstone removes the note); gone (`404`) drops it. Refused drops it when this page already carries the slug (the existing `where.pageSlugs` check, which a rewound full re-read hits) or when the mirror holds the slug. Otherwise refused restores koda's active row through the existing `rowRestoration`, or drops the record when koda has no active row. A refused forget never produces a tombstone. The memory host's `readForgetPendingKeys` adds `pendingForgetKey({ scope, slug })` for every koda forget record, so `forgetPendingKeys()` and `renderIndex()` both carry it: `nax memory list` marks the note `(forget pending)`, and so does the index `host.renderIndex()` renders for a session.

**#2908.** `isMonorepoOrchestratorCommand` moves from `packages/nax/src/test-runners/scoped-selection.ts` into a new leaf module, `packages/nax/src/test-runners/orchestrator-command.ts`, whose only import is `normalizeCommandSpec` and the `QualityCommandSpec` type from `@nathapp/nax-agent/internal`. `scoped-selection.ts` re-exports it, so every existing importer is unchanged. `warnScopedTestCommand` imports the leaf directly, by the relative path `../test-runners/orchestrator-command` (a value import of `@/test-runners/<file>` from `src/` is forbidden by `check-alias-internals` because `src/test-runners/index.ts` exists); importing `scoped-selection.ts` from config would pull `@/logger` and `verification/smart-runner` into config's import graph. After the equality check and before the `{{files}}` check, `warnScopedTestCommand` returns without a warning when `isMonorepoOrchestratorCommand(test)` is true for the declared `quality.commands.test`.

**#2909.** `branchReviewStep` appends the deferred-minor triage to its `log.done` text whenever the record holds deferred minors, counted after this review's triage is applied: `; deferred minors: <n> fix-now, <m> leave`. Nothing else changes, including the `branch fix: N item(s)` ledger note, which stays `NO_MIRROR`.

### Integration (extends existing code)

Baselines below exist only to locate the code; the **Target** is the interface to implement.

Symbols changed:

- `gitWithTimeout` and `_gitDeps` (`packages/nax-agent/src/internal/git-exec.ts`).
  Baseline: `_gitDeps = { spawn, getSafeLogger, gitTimeoutMs, timeoutRetryGitTimeoutMs }`, and the spawn options carry no `detached`.
  Target: `_gitDeps` also holds `killProcessGroup` (default: the `killProcessGroup` exported by `process-kill.ts`). The spawn options carry `detached: true`. The abort and timeout kill calls `_gitDeps.killProcessGroup(proc.pid, "SIGKILL", { singleProcessFallback: false })`, then `proc.kill("SIGKILL")`. The signature and return shape of `gitWithTimeout` are unchanged.
- `ProviderTool` (`packages/nax-agent/src/tools/provider-types.ts`). Target: adds `readonly cancelGraceMs?: number`.
- `CodingTool` (`packages/nax-agent/src/tools/registry.ts`). Target: adds `readonly cancelGraceMs?: number`.
- `adaptProviderTool` (`packages/nax-agent/src/tools/provider-adapt.ts`). Target: the adapted tool carries `cancelGraceMs` when the provider tool declares one, and has no `cancelGraceMs` key otherwise.
- `SessionInteractionDeps` (`packages/nax-agent/src/session/session-interaction.ts`). Target: adds `readonly cancelGraceByTool?: ReadonlyMap<string, number>` and `readonly timers?: { readonly setTimeout: (fn: () => void, ms: number) => unknown; readonly clearTimeout: (id: unknown) => void }`, defaulting to the process globals, so a test can drive the grace on a fake clock. The module exports `MAX_CANCEL_GRACE_MS = 10_000`.
- `nativeBackend` session open (`packages/nax-agent/src/session/native-backend.ts`, the `createSessionInteractionHandler({...})` call). Target: passes `cancelGraceByTool` built from `providerTools.tools`.
- `handOverForget` (`packages/nax-agent/src/memory/operations.ts`) and `applyPushed` (`packages/nax-agent/src/memory/delivery.ts`). Target: as in Approach. `operations.ts` is 599 lines against the 600-line source cap enforced by `bun run check:file-sizes`, so the forget hand-over needs room. For example, `forgetLocked`, `handOverForget` and `queuedForget` can move into a new `packages/nax-agent/src/memory/forget-handover.ts`. They share `refreshIndex` (`operations.ts`, not exported) and `FORGET_STATUS_BY_MODE` with code that stays. A new module that imports those back from `operations.ts`, while `operations.ts` imports it, is an import cycle, which `check-import-cycles` fails. Helpers both need can live in a third leaf module that imports neither (for example `packages/nax-agent/src/memory/operations-support.ts`).
- `KodaClient.post` and `request` (`packages/nax/src/memory/koda-http.ts`). Baseline: `post(path: string, body: unknown): Promise<KodaResponse>`. Target: `post(path: string, body: unknown, opts?: { readonly signal?: AbortSignal }): Promise<KodaResponse>`.
- `createKodaFlow` (`packages/nax/src/chat/flow/flow-koda.ts`). Baseline: `createKodaFlow(connection, body)`. Target: `createKodaFlow(connection: KodaFlowConnection, body: FlowCreateBody, signal?: AbortSignal): Promise<FlowCreateOutcome>`.
- `createFlow`, `afterAllow` and `sendTool` (`packages/nax/src/chat/flow/flow-provider.ts`). Target: as in Approach. The module exports `FLOW_SEND_CANCEL_GRACE_MS = 5_000`.
- `KodaApproval` and `createKodaApprovals` (`packages/nax/src/memory/koda-approvals.ts`). Target: `KodaApproval` adds `readonly kind?: "save" | "forget"`.
- `retire` inside `createKodaMemoryProvider` (`packages/nax/src/memory/koda-provider.ts`).
- `resolveRecord` and `refusedRecord` (`packages/nax/src/memory/koda-pull.ts`).
- `readForgetPendingKeys` and `composeKoda` (`packages/nax/src/memory/host.ts`; 591 lines, 600 cap). Target: `composeKoda` hands back the approvals store it creates alongside the provider, `MemoryParts` gains an optional `kodaApprovals?: KodaApprovals`, and `readForgetPendingKeys` adds the forget records' keys. That is more than the 9 lines `host.ts` has left, so `readForgetPendingKeys` and `pendingForgetKey` can move to a new `packages/nax/src/memory/host-forget-keys.ts`, with `pendingForgetKey` still exported from the `@/memory` barrel.
- `warnScopedTestCommand` (`packages/nax/src/config/config-guards.ts`; 593 lines, 600 cap: the leaf import and the early return must keep it at 600 or under).
- `isMonorepoOrchestratorCommand`, which moves to `packages/nax/src/test-runners/orchestrator-command.ts` and is re-exported from `scoped-selection.ts`.
- `branchReviewStep` (`packages/nax/src/workflow/feature-steps.ts`; 497 lines).

Symbols read, unchanged:

- `killProcessGroup(pid, signal, opts?)` (`packages/nax-agent/src/internal/process-kill.ts`): refuses `pid <= 1`, signals `-pid`, and with `singleProcessFallback: false` does not fall back to the bare pid on `ESRCH`.
- `raceAbort` and `runCodingTool` (`session-interaction.ts`): the abandoned outcome is `{ kind: "error", content: 'Tool "<name>" was abandoned: the turn ended.' }`.
- `restoreForgotten(input, previous)` (`packages/nax-agent/src/memory/refusal.ts`) and `rewindPullCursor(store, scope)` (`packages/nax-agent/src/memory/sync-drain.ts`).
- `rowRestoration`, `restorableNote` and `findActiveKodaNote` (`koda-pull.ts`, `koda-lookup.ts`); `pendingForgetKey` (`host.ts`).
- `describeFindings` (`packages/nax/src/workflow/run-log.ts`); `MinorTriageDecision = "fix-now" | "leave"` (`packages/nax/src/operations/workflow-types.ts`).
- `botGit` (`packages/nax/src/bot/git.ts`) and `captureWorkingTreeChanges` (`packages/nax/src/utils/git.ts`), both of which call `gitWithTimeout` with a timeout.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Group kill on a platform without process groups | `killProcessGroup` throws or reports sent; the direct `proc.kill("SIGKILL")` still runs. |
| Git exits before the kill | Both kill calls are each in a try; the result is the normal exit. |
| Tool with a grace settles after the grace | The answer is the generic abandoned outcome; the late settlement is ignored. |
| Tool with a grace rejects inside the grace | Handled as an unaborted call's rejection is handled today. |
| Declared grace is `NaN`, `Infinity`, `0` or negative | Treated as no grace. |
| koda answers before the abort lands | The answer is used (created or held), as without a signal. |
| Signal aborted before `post` | Rejects `MEMORY_KODA_ABORTED`; `fetch` is never called. |
| Abort during the koda create | `MEMORY_KODA_ABORTED`; flow send reports "may have created the flow". |
| `202` retire without a string `data.id` | The provider's existing bad-response error; nothing is recorded. |
| Approvals file unreadable on `record` of a forget | A warn is logged and the forget still resolves `pending`; nothing is recorded. |
| Refused forget whose slug the page already carries | The record is dropped; no second restore. |
| ssh needs a terminal prompt for a detached git | The git call fails at once (no controlling terminal); declared, not fixed. |
| Refused forget, mirror lacks the slug, koda's row is not mirror-holdable | `rowRestoration` warns and keeps the record (existing behaviour). |

## Out of Scope

- `nax memory status` reporting a refused koda proposal, whether a save or a forget: status reads only the outbox today, and a refused koda record is resolved without a report. This is a follow-up to #2905.
- The `(forget pending)` marker in the on-disk `index.md` that nax-agent's `refreshIndex` writes, and `index-render.ts`'s own reads, for a koda-held forget: they read only the outbox and the local `pending-forgets.jsonl` record. `nax memory list` and `host.renderIndex()` (which read `readForgetPendingKeys`) do mark it.
- Writing a koda-held forget into the mirror's `pending-forgets.jsonl` record: `nax memory approve <slug>` would then retire the note locally without koda's decision.
- A save of a slug while a koda forget of it is pending: the two records coexist and each resolves on its own.
- A cancel grace for embedder tools (`EmbedderTool`), or a grace that any tool other than `nax-flow__send` declares.
- Appending a tool's late result to the transcript after its grace has passed.
- Asking koda after a cancelled create whether the flow exists: the result says the outcome is unknown.
- Mirroring the `branch fix: N item(s): ...` ledger note to the run log.
- Reading `review.commands.test` in `warnScopedTestCommand`: only the declared `quality.commands.test` decides the orchestrator check.
- Killing git when nax itself exits mid-call: a detached git no longer receives the terminal's SIGINT, and the timeout timer dies with nax, so a nax killed during `botGit` or `commitAndPush` can leave git and its helpers running (`argvExec` has the same trait).
- Running scoped test files through an orchestrator at the repo root: `RunCommand testScoped` keeps running the package-filtered command.
- Changing `makeSpawnResult`'s default pid in `packages/test-kit`, or installing a default `_gitDeps.killProcessGroup` stub in a test preload.
- Keeping a terminal for git's ssh transport: a detached git cannot answer an ssh passphrase or host-key prompt on the terminal.

## Stories

### US-001 — gitWithTimeout kills git's whole process group

Workdir: packages/nax-agent. No dependencies.

`gitWithTimeout` spawns git as a process-group leader and kills the group, then the git pid, on abort and on timeout, through the new `_gitDeps.killProcessGroup` seam.

### US-002 — nax's git callers reach the group kill

Workdir: packages/nax. Depends on US-001.

nax's own entry points to `gitWithTimeout` (`botGit` and `captureWorkingTreeChanges`) kill through `_gitDeps.killProcessGroup`. nax's fake-spawn git tests stub that seam, so no test sends a real signal to the fake pid.

### US-003 — a provider tool's cancel grace

Workdir: packages/nax-agent. No dependencies.

`ProviderTool.cancelGraceMs` is copied onto the adapted `CodingTool`, `nativeBackend` passes the per-tool grace to the interaction handler, and `runCodingTool` waits up to that grace for the tool's own outcome after the turn aborts.

### US-004 — a forget answered pending keeps its note

Workdir: packages/nax-agent. No dependencies.

Under `direct`, a forget the provider answers `pending` puts the note back on the hand-over path, and rewinds the scope's pull cursor on the drain path.

### US-005 — flow send stops the koda create and says what happened

Workdir: packages/nax. Depends on US-003.

`KodaClient.post` takes an optional signal. `createKodaFlow` passes it, flow send hands the turn signal through, reports the cancelled create, and declares `FLOW_SEND_CANCEL_GRACE_MS`.

### US-006 — koda records and resolves a held forget

Workdir: packages/nax. Depends on US-004.

A `202` retire records a `kind: "forget"` approval, a pull resolves it, and `nax memory list` marks the note `(forget pending)`.

### US-007 — no `{{files}}` warning for an orchestrator test command

Workdir: packages/nax. No dependencies.

`isMonorepoOrchestratorCommand` moves to a leaf module, and `warnScopedTestCommand` skips the `{{files}}` warning when `quality.commands.test` is a turbo/nx command.

### US-008 — the branch-review line counts triaged deferred minors

Workdir: packages/nax. No dependencies.

`branchReviewStep` appends `; deferred minors: <n> fix-now, <m> leave` to its step line whenever the record holds deferred minors.

### Context Files

**US-001**
- `packages/nax-agent/src/internal/git-exec.ts` — `gitWithTimeout`, `_gitDeps`.
- `packages/nax-agent/src/internal/process-kill.ts` — `killProcessGroup`.
- `packages/nax-agent/src/internal/argv-exec.ts` — the `detached: true` spawn and `_argvExecDeps.killProcessGroup` precedent.
- `packages/test-kit/src/bun/spawn.ts` — `makeSpawnResult`, `FakeProcSpec`.
- `packages/nax-agent/test/unit/internal/git-env.test.ts` — the `gitWithTimeout abort signal (#2895)` describe.

**US-002**
- `packages/nax/src/bot/git.ts` — `botGit`.
- `packages/nax/src/utils/git.ts` — `captureWorkingTreeChanges`, the `_gitDeps` re-export.
- `packages/nax/test/unit/bot/git.test.ts` — `AC-3 forwards the deadline and kills a hung git`.
- `packages/nax/test/unit/utils/git.test.ts` — `does not stall when git subprocess hangs (SIGKILL after timeout)`.

**US-003**
- `packages/nax-agent/src/session/session-interaction.ts` — `raceAbort`, `runCodingTool`, `SessionInteractionDeps`.
- `packages/nax-agent/src/session/native-backend.ts` — the `createSessionInteractionHandler` call.
- `packages/nax-agent/src/tools/provider-adapt.ts` — `adaptProviderTool`.
- `packages/nax-agent/src/tools/provider-types.ts` — `ProviderTool`.
- `packages/nax-agent/test/unit/session/native-backend-providers.test.ts` — the `AC-3` `onInteraction` harness.

**US-004**
- `packages/nax-agent/src/memory/operations.ts` — `forgetLocked`, `handOverForget`, `queuedForget`.
- `packages/nax-agent/src/memory/delivery.ts` — `applyPushed`.
- `packages/nax-agent/src/memory/sync-drain.ts` — `settle`, `rewindPullCursor`.
- `packages/nax-agent/src/memory/refusal.ts` — `restoreForgotten`.
- `packages/nax-agent/test/unit/memory/operations-forget.test.ts` — the forget operation harness.

**US-005**
- `packages/nax/src/memory/koda-http.ts` — `createKodaClient`, `request`, `KodaClient`.
- `packages/nax/src/chat/flow/flow-koda.ts` — `createKodaFlow`.
- `packages/nax/src/chat/flow/flow-provider.ts` — `afterAllow`, `createFlow`, `sendTool`, `kodaFailure`.
- `packages/nax/test/unit/chat/flow/flow-provider.test.ts` — the `_flowProviderDeps` harness.
- `packages/nax/test/unit/memory/koda-http.test.ts` — the `_kodaClientDeps.fetch` harness.

**US-006**
- `packages/nax/src/memory/koda-approvals.ts` — `KodaApproval`, `approvalOf`, `createKodaApprovals`.
- `packages/nax/src/memory/koda-provider.ts` — `retire`, `recordProposal`.
- `packages/nax/src/memory/koda-pull.ts` — `resolveRecord`, `refusedRecord`, `rowRestoration`.
- `packages/nax/src/memory/host.ts` — `composeKoda`, `readForgetPendingKeys`, `pendingForgetKey`.
- `packages/nax/src/cli/memory.ts` — `listingLine`, `FORGET_PENDING_SUFFIX`.

**US-007**
- `packages/nax/src/config/config-guards.ts` — `warnScopedTestCommand`.
- `packages/nax/src/test-runners/scoped-selection.ts` — `isMonorepoOrchestratorCommand`.
- `packages/nax/test/unit/config/config-guards.test.ts` — `warnScopedTestCommand (US-006)` describe.

**US-008**
- `packages/nax/src/workflow/feature-steps.ts` — `branchReviewStep`, `fixNowMinors`.
- `packages/nax/src/workflow/run-log.ts` — `describeFindings`.
- `packages/nax/test/unit/workflow/feature-machine-log.test.ts` — the step-line capture.

### Creates

**US-001**
- `packages/nax-agent/test/integration/internal/git-exec-group-kill.test.ts`

**US-004**
- `packages/nax-agent/src/memory/forget-handover.ts`
- `packages/nax-agent/src/memory/operations-support.ts`
- `packages/nax-agent/src/memory/pull-cursor.ts`

**US-005**
- `packages/nax/test/unit/chat/flow/flow-provider-cancel.test.ts`

**US-006**
- `packages/nax/src/memory/host-forget-keys.ts`
- `packages/nax/test/unit/memory/koda-pull-forget-approvals.test.ts`

**US-007**
- `packages/nax/src/test-runners/orchestrator-command.ts`

### Modifies

**US-001**
- `packages/nax-agent/test/unit/internal/git-env.test.ts` — the `gitWithTimeout abort signal (#2895)` tests fake `_gitDeps.spawn` (pid 4242) and reach the kill; each must also replace `_gitDeps.killProcessGroup` with a recording stub (restored after the test), so no real `SIGKILL` reaches process group 4242. Their existing `proc.killed` and result assertions stay.
- `packages/nax-agent/test/unit/tools/git-commit.test.ts` — the test whose faked `check-ignore` hangs reaches the timeout kill through a faked spawn (pid 4242); it must also replace `_gitDeps.killProcessGroup` with a recording stub (restored after the test). Its existing assertions stay.

**US-002**
- `packages/nax/test/unit/bot/git.test.ts` — `AC-3 forwards the deadline and kills a hung git` fakes `_gitDeps.spawn` (pid 4242) and reaches the timeout kill; it must also replace `_gitDeps.killProcessGroup` with a recording stub (restored after the test). Its `killed` and `timedOut` assertions stay.
- `packages/nax/test/unit/utils/git.test.ts` — `does not stall when git subprocess hangs (SIGKILL after timeout)` fakes `_gitDeps.spawn` (pid 4242) and reaches three timeout kills; it must also replace `_gitDeps.killProcessGroup` with a recording stub (restored after the test). Its `killCount` of 3 still holds, because `proc.kill` still runs once per call.
- `packages/nax/test/unit/review/runner.test.ts` — the `getUncommittedFilesImpl — BUG-1 pipe-drain regression` suite fakes `_gitDeps.spawn` (pid 4242) with `_gitDeps.gitTimeoutMs` at 50 and reaches the timeout kill; each of its tests must also replace `_gitDeps.killProcessGroup` with a recording stub (restored in `afterEach`). Its existing assertions stay.

**US-004**
- `packages/nax-agent/src/memory/sync-drain.ts` — `rewindPullCursor` is removed from this file's own body and re-exported from the new pull-cursor leaf module this story creates; `drainOutbox` and every other export keep their behaviour.
- `packages/nax-agent/src/memory/operations.ts` — at 599 lines against the 600-line cap, it may hand `handOverForget` and `queuedForget` to the new forget hand-over module this story creates; `forgetMemoryNote`'s exported signature and behaviour for every answer other than `pending` under `direct` stay.

**US-006**
- `packages/nax/test/unit/memory/koda-provider-forget-search.test.ts` — the table row `["a 202", 202, "pending"]` builds the provider with an approvals double that may not expect a `record` call; the row keeps answering `pending`; its approvals double already supplies `record`, and now receives one `record` call with `kind: "forget"`, so no change to the double is needed unless the test asserts the double was never called.
- `packages/nax/test/unit/memory/koda-approvals.test.ts` — the assertions on the written file shape (`{ version: 1, approvals: [...] }` entries with exactly `approvalId`, `scope`, `slug`, `clientId`) gain `kind` where a record was made with one; a record made without `kind` is still written without it.

- `packages/nax/src/memory/host.ts` — at 591 lines against the 600-line cap, it may hand `readForgetPendingKeys` and `pendingForgetKey` to the new host forget-keys module this story creates, and re-export `pendingForgetKey`; `createMemoryHost`'s returned host keeps every member and its behaviour, except that `forgetPendingKeys()` now also holds koda forget records' keys.
- `packages/nax/src/memory/index.ts` — the barrel keeps exporting `pendingForgetKey`, now from wherever it lives.

**US-007**
- `packages/nax/src/test-runners/scoped-selection.ts` — `isMonorepoOrchestratorCommand` is removed from this file's own body and re-exported from the new leaf module this story creates; every importer keeps importing it from here unchanged.

### Seams

- US-001 → US-002: `_gitDeps.killProcessGroup`, added by US-001, is called through nax's `botGit` and `captureWorkingTreeChanges`.
- US-003 → US-005: `ProviderTool.cancelGraceMs`, honoured by US-003's `runCodingTool`, is declared by US-005's `nax-flow__send`.
- US-004 → US-006: US-004's put-back of a `pending` forget is what leaves the note in the mirror for US-006's `(forget pending)` marker and refused-forget resolution.

## Acceptance Criteria

### US-001

1. [unit] With `_gitDeps.spawn` faked to a hanging process and `_gitDeps.killProcessGroup` stubbed, `gitWithTimeout(["push"], dir, 5_000, undefined, undefined, undefined, signal)` spawns with options that include `detached: true`.
2. [unit] In the setup of criterion 1, aborting `signal` calls `_gitDeps.killProcessGroup` once with the fake's pid, `"SIGKILL"` and `{ singleProcessFallback: false }`.
3. [unit] In the setup of criterion 1, aborting `signal` also calls the fake process's `kill("SIGKILL")`, after the `killProcessGroup` call.
4. [unit] With a hanging fake spawn and a stubbed `_gitDeps.killProcessGroup`, a `gitWithTimeout(["fetch"], dir, 20)` timeout calls `killProcessGroup` once with the fake's pid, `"SIGKILL"` and `{ singleProcessFallback: false }`, and resolves `{ stdout: "", stderr: "", exitCode: 1, timedOut: true }`.
5. [unit] When the stubbed `_gitDeps.killProcessGroup` throws, an abort still calls the fake process's `kill("SIGKILL")` and resolves with `aborted: true`.
6. [unit] A git call that exits 0 before any abort or timeout calls `_gitDeps.killProcessGroup` zero times.
7. [unit] `_gitDeps.killProcessGroup` is, by default, the `killProcessGroup` function exported by `packages/nax-agent/src/internal/process-kill.ts`.
8. [integration] On POSIX, with the real spawn, a `gitWithTimeout` run of a git alias that starts a shell which starts `sleep 3003` (e.g. `-c alias.hang='!sh -c "sleep 3003"'` and the argv `["git", "-c", ..., "hang"]`), aborted 200 ms after start, leaves no process in the spawned git's process group alive within 2 s of the result. The test captures git's pid by wrapping `_gitDeps.spawn` around the real spawn, and reads group membership with `ps -o pid=,pgid=`.

### US-002

1. [unit] `botGit(["fetch"], "/repo", 50)` with `_gitDeps.spawn` faked to a hanging process and `_gitDeps.killProcessGroup` replaced by a recording stub calls the stub once with the fake's pid and `"SIGKILL"`.
2. [unit] `captureWorkingTreeChanges` with every git call faked to hang and `_gitDeps.killProcessGroup` replaced by a recording stub calls the stub once per hung git call, with each fake's pid.

### US-003

1. [unit] `adaptProviderTool("acme", { localName: "put", ..., cancelGraceMs: 2_000 })` returns a tool whose `cancelGraceMs` is `2_000`.
2. [unit] `adaptProviderTool` on a provider tool without `cancelGraceMs` returns a tool that has no `cancelGraceMs` key.
3. [unit] `MAX_CANCEL_GRACE_MS` exported from `session-interaction.ts` equals `10_000`.
4. [unit] A handler from `createSessionInteractionHandler` with `cancelGraceByTool` mapping `acme__put` to `500`, whose runtime's `callTool` resolves `{ kind: "ok", content: "done" }` 50 ms after the request signal aborts, answers `{ answer: "done" }` for an `acme__put` coding-tool request aborted mid-call.
5. [unit] In the setup of criterion 4, with `callTool` resolving `{ kind: "error", content: "[chat] nothing was pushed" }` 50 ms after the abort, `onInteraction` rejects with an error whose message is `[chat] nothing was pushed`.
6. [unit] In the setup of criterion 4, with `callTool` resolving `{ kind: "denied", reason: "no", breach: false }` 50 ms after the abort, `onInteraction` answers `{ answer: "Denied: no", denied: { reason: "no", breach: false } }`.
7. [unit] In the setup of criterion 4, with `callTool` resolving 1 s after the abort (past the 500 ms grace), `onInteraction` rejects with the message `Tool "acme__put" was abandoned: the turn ended.` once the fake clock passes 500 ms after the abort, and not before.
8. [unit] A coding-tool request for a tool absent from `cancelGraceByTool`, whose `callTool` never settles, rejects with `Tool "<name>" was abandoned: the turn ended.` without the fake clock advancing.
9. [unit] A request whose signal is already aborted when it arrives rejects with the abandoned message and never calls `callTool`, even when the tool's grace is `500`.
10. [unit] A grace of `NaN`, `0` or `-5` for a tool whose `callTool` never settles rejects with the abandoned message without the fake clock advancing.
11. [unit] A grace of `60_000` for a tool whose `callTool` never settles rejects with the abandoned message once the fake clock passes 10 s after the abort, and not before.
12. [unit] After a grace-path answer (criterion 4), the fake clock reports zero outstanding timers.
13. [unit] Criteria 4 to 12 run on a fake clock passed as `SessionInteractionDeps.timers`, never on wall time: criterion 7's test, run on that clock, completes in under 100 ms of wall time.
14. [unit] Opening a session through `nativeBackend` with a static provider whose tool `put` declares `cancelGraceMs: 500` and resolves `"late"` 50 ms after its signal aborts, then calling `opened.turnOpts().interactionHandler.onInteraction` for `acme__put` with a signal aborted mid-call, answers `{ answer: "late" }`.
15. [unit] A tool with a 500 ms grace whose `callTool` rejects 1 s after the abort (past the grace) produces no unhandled rejection: the test's unhandled-rejection listener records nothing after the fake clock passes 1 s.
16. [unit] The same `nativeBackend` session open with a provider tool that declares no `cancelGraceMs` and never settles rejects with the abandoned message as soon as the signal aborts.

### US-004

1. [unit] `forgetMemoryNote` with `writeMode: "direct"`, a mirror holding note `x`, and a provider whose `push` resolves `{ id, status: "pending" }` returns `status: "pending"` and leaves `store.readNote("project", "x")` equal to the note as it was before the forget.
2. [unit] In the setup of criterion 1, the outbox holds no entry for `x` after the call.
3. [unit] In the setup of criterion 1, the memory index the call refreshes still lists `x`: the note is restored before the index is refreshed.
4. [unit] `forgetMemoryNote` with `writeMode: "direct"` and a provider answering `{ status: "deleted" }` leaves `store.readNote("project", "x")` returning `null`.
5. [unit] `forgetMemoryNote` with `writeMode: "proposal"` and a provider answering `{ status: "pending" }` leaves note `x` in the mirror unchanged.
6. [unit] `applyPushed` for a `forget` entry of scope `project` answered `{ status: "pending" }` sets the store's sync-state `cursor.project` to `null` and leaves `cursor.user` unchanged.
7. [unit] `applyPushed` for a `forget` entry answered `{ status: "deleted" }` deletes the note and leaves the sync-state cursor unchanged.
8. [unit] `applyPushed` for a `forget` entry whose `writeMode` is `proposal`, answered `{ status: "pending" }`, leaves the sync-state cursor unchanged and the note in the mirror.
9. [integration] A sync whose drain pushes a queued `direct` forget of note `x` (deleted when queued) to a provider that answers `pending`, and whose provider pull serves `x` as active, ends with `x` in the mirror.

### US-005

1. [unit] With `_kodaClientDeps.fetch` faked to answer 201 after 100 ms, `createKodaClient(...).post("fleet/flows", body, { signal })` with `signal` aborted at 10 ms rejects with a `NaxError` coded `MEMORY_KODA_ABORTED`.
2. [unit] In the setup of criterion 1, the `RequestInit` passed to the faked fetch carries a signal that is aborted once the call has rejected.
3. [unit] `post(path, body, { signal })` with `signal` already aborted rejects `MEMORY_KODA_ABORTED` and calls the faked fetch zero times.
4. [unit] `post(path, body, { signal })` whose faked fetch answers 201 before `signal` aborts resolves `{ status: 201, data }`.
5. [unit] `post(path, body)` without a third argument, whose fetch answers after the client's `timeoutMs`, still rejects `MEMORY_KODA_TIMEOUT`.
6. [unit] `createKodaFlow(connection, body, signal)` calls the stubbed client's `post` with `("fleet/flows", body, { signal })`.
7. [unit] The `nax-flow__send` tool from `createFlowProvider(...).tools()` has `cancelGraceMs` equal to `FLOW_SEND_CANCEL_GRACE_MS`, which equals `5_000`.
8. [unit] Running the send tool through the `_flowProviderDeps` harness with an approved card, a `commitAndPush` that resolves, and a `createKodaFlow` stub, passes the run context's `signal` as `createKodaFlow`'s third argument.
9. [unit] In the setup of criterion 8, with `createKodaFlow` rejecting a `NaxError` coded `MEMORY_KODA_ABORTED`, the tool result is the error `[chat] the turn was cancelled during the koda request; branch <branch> stays pushed and koda may have created the flow; check koda's flows before sending again (a duplicate send is refused with 409)`, with `<branch>` the carded branch.
10. [unit] In the setup of criterion 8, with the signal aborted after `createKodaFlow` resolves `{ kind: "created", ... }`, the tool result is the same created-flow content as with no abort.
11. [unit] In the setup of criterion 8, with `commitAndPush` rejecting while the signal is aborted, the tool result is still `[chat] the turn was cancelled; nothing was pushed` and `createKodaFlow` is never called.

### US-006

1. [unit] `createKodaApprovals(...).record({ approvalId: "apr_1", kind: "forget", scope: "project", slug: "x", clientId: "c_1" })` followed by `list()` returns that entry with `kind: "forget"`.
2. [unit] `list()` on a file whose entry has no `kind` field returns that entry with no `kind` (a save).
3. [unit] Recording a `kind: "forget"` entry for `project/x` after a save entry for `project/x` leaves both entries in `list()`.
4. [unit] Recording a second `kind: "forget"` entry for `project/x` replaces the first forget entry for `project/x`.
5. [unit] The koda provider's `push` of a forget whose `POST memory/notes/<id>/retire` answers `202` with `data.id` `"apr_9"` calls `approvals.record` once with `{ approvalId: "apr_9", kind: "forget", scope, slug, clientId }` from the request, and resolves `status: "pending"`.
6. [unit] A forget whose retire answers `202` without a string `data.id` rejects with the provider's bad-response error and records nothing.
7. [unit] A forget whose retire answers `200` records nothing and resolves `status: "deleted"`.
8. [unit] A pull at the scope's last page, with a forget record for `x` that `GET approvals/<id>` answers with an open status, keeps the record and restores no note.
9. [unit] A pull with a forget record for `x` answered `executed` drops the record.
10. [unit] A pull with a forget record for `x` answered with a refused status, while the mirror holds `x`, drops the record and the page carries no note for `x`.
11. [unit] A pull with a forget record for `x` answered with a refused status, while the mirror does not hold `x` and koda's active-row lookup returns a holdable row for `x`, carries that row's note for `x` in the page and keeps the record.
12. [unit] A pull with a forget record for `x` answered with a refused status, while the mirror does not hold `x` and koda's lookup returns no active row, drops the record and the page carries no note for `x`.
13. [unit] No refused forget record produces a note whose status is `rejected`.
14. [unit] A pull with a forget record whose approval read answers `404` drops the record.
15. [unit] A pull whose page already carries a note for `x`, with a forget record for `x` answered with a refused status, drops the record and adds no second note for `x` to the page.
16. [unit] A pull with a forget record for `x` answered with a refused status, while the mirror does not hold `x` and koda's active row for `x` is not a note the mirror can hold, keeps the record, logs the warn `koda approval was not resolved`, and the page carries no note for `x`.
17. [unit] A forget whose retire answers `202` with `data.id` `"apr_9"` while `approvals.record` rejects `MEMORY_KODA_APPROVALS_READ_FAILED` resolves `status: "pending"` and logs one warn naming the slug and `apr_9`.
18. [unit] `list()` on a file whose entry has `kind: "later"` returns that entry read as a save, and the other entries of the file unchanged.
19. [unit] `renderIndex()` of a koda-backed memory host whose approvals store holds a forget record for `project/x`, with note `x` in the mirror, renders the `x` entry marked as forget pending, as it does for a local recorded forget.
20. [unit] `forgetPendingKeys()` of a koda-backed memory host whose approvals store holds a forget record for `project/x` and a save record for `project/y` returns a set containing `project/x` and not `project/y`.
21. [unit] `nax memory list` through a host whose `forgetPendingKeys()` returns `project/x`, with note `x` in the mirror, prints the `x` line ending in ` (forget pending)`.
22. [integration] With a faked koda transport, a `nax memory forget x` whose retire answers `202`, followed by `nax memory list`, prints `x` with ` (forget pending)`. A sync whose approval read then answers a refused status, followed by `nax memory list`, prints `x` without the suffix.

### US-007

1. [unit] `isMonorepoOrchestratorCommand("npx turbo test")` imported from `packages/nax/src/test-runners/orchestrator-command.ts` returns `true`.
2. [unit] `isMonorepoOrchestratorCommand` imported from `scoped-selection.ts` is the same function as the one from `orchestrator-command.ts`.
3. [unit] `warnScopedTestCommand({ quality: { commands: { test: "npx turbo test", testScoped: "npx turbo test --filter=[HEAD^1]" } } }, warn)` never calls `warn`.
4. [unit] `warnScopedTestCommand` with `test: "nx affected -t test"` and `testScoped: "nx affected -t test --base=HEAD~1"` never calls `warn`.
5. [unit] `warnScopedTestCommand` with `test: "npx turbo test"` and `testScoped: "npx turbo test"` calls `warn` once with `quality.commands.testScoped equals quality.commands.test, so every scoped run is the full suite`.
6. [unit] `warnScopedTestCommand` with `test: "bun test"` and `testScoped: "bun test --bail"` still calls `warn` once with the `{{files}}` placeholder message.
7. [unit] `warnScopedTestCommand` with `testScoped: "npx turbo test --filter=[HEAD^1]"` and no `test` command still calls `warn` once with the `{{files}}` placeholder message.

### US-008

1. [unit] A feature-machine run whose branch review returns no findings and triages two of three deferred minors `fix-now` logs a `branch-review:` step line containing `no findings; deferred minors: 2 fix-now, 1 leave`.
2. [unit] A branch review with one important finding and one deferred minor triaged `leave` logs a step line ending, before the elapsed time, with `; deferred minors: 0 fix-now, 1 leave`.
3. [unit] A branch review of a record with no deferred minors logs a step line with no `deferred minors` text.
4. [unit] A deferred minor the review's `minorTriage` does not mention is counted as `leave`.
