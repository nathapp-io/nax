# SPEC: review f32f222f fixes: memory compaction, web exposure, sandbox placeholders and bot ledger

Closes: #3052, #3053, #3054, #3055, #3056, #3057, #3058, #3059, #3060, #3061, #3062, #3063

## Summary

Twelve fixes from the verified scope review of `v0.93.0..f32f222fc` (`projects/nax/review-f32f222f/REVIEW.md`, outside this repository), one story per subsystem:

1. **Memory compaction (#3052).** A merge's source retirements are delivered only after the provider accepts the merged replacement. A refused replacement leaves its sources unsent and rejected. A whitespace-only note body is refused at write validation, as Koda refuses it.
2. **Bash full network (#3053).** Once a session has read web content, a `network: "full"` Bash call runs outside the sandbox, and its approval now says so. Whether it runs outside the sandbox is decided once, when the call is assessed, and that decision is what launches.
3. **Web tools (#3060, #3062, #3063).** The fetch approval names the destination URL. A search backend answering a redirect fails as a non-2xx status. Model-facing truncation of a fenced web result keeps the closing `</web-content>` line.
4. **Sandbox placeholders (#3055, #3059, #3061).** Pending placeholder-ledger entries are dropped once no wrapped command can still create them, so a later user file is never adopted. The staging exclusion of mandatory placeholder names applies on Linux only. Rewriting `.git/info/exclude` keeps the file's group-write bit.
5. **Chat URL recording (#3054).** Only text a person typed is recorded as a seen URL, on a send and on an accepted steer. Background-task and job notices are never recorded.
6. **Koda proposal mode (#3056).** Compaction apply and undo read Koda's effective write mode and refuse up front when it is `proposal`.
7. **Bot advisor ledger (#3057, #3058).** The in-place ledger commit refreshes the user's index entry only when the user has not staged a different version. A PR ledger that diverged from the main checkout's still gains the main ledger's missing entries, appended.

## Motivation

The review verified each defect at `f32f222fc` (= `main`):

- **#3052.** `stageAndRecord` (`packages/nax-agent/src/memory/compaction-apply.ts`) stages the merged note's `save`, then one `forget` per merge source, as independent outbox entries. `drainOutbox` (`sync-drain.ts`) marks a `MEMORY_PUSH_REJECTED` save `rejected` and keeps draining, so the source forgets are delivered. The case was reproduced through `applyMemoryCompaction` plus `drainOutbox`, with a provider that refuses saves. For a merge into another owner's slug (Koda 403), the provider received `save:a` and then `forget:b`, and the drain returned pushed 1, rejected 1. For a whitespace-only merged body (Koda 400), it received `save:merged`, `forget:a`, `forget:b`, with pushed 2, rejected 1. Koda then holds no merged note and has retired the sources. `validateMemoryNoteWrite` (`validate.ts`) checks body size and secrets but not a blank body.
- **#3053.** `requestsUnwrapped` (`packages/nax-agent/src/tools/bash.ts`) runs a `network: "full"` call unwrapped when `opts.fullNetwork.isExposed()` is true at launch. The approval reason is the guard's "full network after this session read web content" (`web/guard.ts`). The "runs OUTSIDE the sandbox" suffix and the `unsandboxed: true` flag on the request are attached only for `unsandboxed: true` (`resolveUnsandboxedCall`, `runtime-calltool.ts`). Exposure is read again at launch, so a call assessed while unexposed can launch unwrapped with no ask.
- **#3054.** `wrapWebSession` (`packages/nax/src/chat/session-web.ts`) records every URL in every `send`. Background-task notices are delivered as ordinary sends (`deliver: (text) => sendTurn({ message: text })` in `ChatApp.tsx`) or as steers (`useTaskNoticeSteer` in `use-jobs.ts`). They embed each task's raw command (`taskNoticeLine`, `prompts/builders/background-builder.ts`). A model-authored background command can therefore mark any URL as seen, and a later `web__fetch` of that URL skips the unseen-URL ask. A human steer bypasses the recorder.
- **#3055.** A ledger entry recorded by `recordAbsent` stays pending until `observe` identifies it, and `prune` keeps pending entries (`placeholder-ledger.ts`). A user file created later at that path, empty and placeholder-shaped, is adopted by the next `observe`. The sweep after an unclean exit can then delete it.
- **#3056.** `createHostCompaction` refuses apply and undo only when the local `memory.writeMode` is `proposal` (`packages/nax/src/memory/host-compact.ts`). Koda decides the effective mode per principal (`proposal` for an agent under an approval policy), and the Koda provider already reads `GET projects/<p>/memory/write-mode` in `reachable()` (`koda-provider.ts`).
- **#3057.** `refreshIndexEntry` (`packages/nax/src/bot/ledger-carry.ts`) runs `git reset -q HEAD -- <ledger>` unconditionally after the in-place commit. That clears a different ledger version the user staged during the run.
- **#3058.** `carry` skips with "Main checkout ledger does not extend the PR's; not carried" whenever the PR ledger holds lines the main ledger lacks. The PR ledger then misses the main ledger's newer audit entries.
- **#3059.** `stagingPlaceholderPaths` (`packages/nax-agent/src/sandbox/staging-placeholders.ts`) excludes every untracked, empty, read-only file at a mandatory name on every platform. bwrap placeholders exist only on Linux, so on macOS a legitimate such file (e.g. `.mcp.json`) is never staged.
- **#3060.** `applyModelTruncationPolicy` (`packages/nax-agent/src/tools/spill.ts`) cuts a long fenced web result at its head, and the closing `</web-content>` line is lost. A 1,103-line page reproduced it.
- **#3061.** `replaceAtomically` (`packages/nax-agent/src/sandbox/placeholder-excludes.ts`) passes the old mode to `writeFileSync`, which the umask masks. In a `git init --shared=group` repository under umask `0022`, the exclude file went from `0664` to `0644`.
- **#3062.** The fetch tool (`fetchTool`, `packages/nax-agent/src/web/provider.ts`) declares no `summaryFields`, so `askSummary` renders `web__fetch` alone and the person never sees the destination.
- **#3063.** `send` (`packages/nax-agent/src/web/search-request.ts`) calls fetch with no `redirect` option, so a 302 is followed and its target's body parsed. The search spec (`.nax/features/chat-web-search/spec.md`) requires a non-2xx status to throw `WEB_SEARCH_FAILED`.

## Design

### Size budget

Two touched source files sit at the 600-line source cap enforced by `bun run check:file-sizes`: `packages/nax-agent/src/tools/runtime.ts` (599 lines) and `packages/nax/src/chat/chat-host.ts` (595 lines). `packages/nax/src/memory/host.ts` is at 600. New logic for those call sites goes in the new or sibling files named below, and each of those three files must end at 600 lines or fewer. `ChatApp.tsx` is not gated.

### Integration

Symbols this feature only reads:

- `packages/nax-agent/src/memory/delivery.ts`: `applyPushed(input, entry, result)`.
- `packages/nax-agent/src/memory/note.ts`: `isMemoryPushRejected(error)`, `isMemoryBadResponse(error)`.
- `packages/nax-agent/src/memory/types.ts`: `MEMORY_CLIENT_ID_RE`, `MEMORY_PUSH_MAX_BAD_RESPONSES`.
- `packages/nax-agent/src/web/guard.ts`: `createWebExposureGuard`, `WebExposureGuard.exposedNetwork()`, `FULL_NETWORK_REASON` text "full network after this session read web content".
- `packages/nax-agent/src/coding-tools/coding-tool-extras.ts`: `fullNetworkOption(port)`, which builds Bash's `fullNetwork.isExposed()` from `port.exposedNetwork?.() !== undefined`.
- `packages/nax-agent/src/tools/ask-request.ts`: `askSummary(tool, scope, input)`, `unsandboxedReasonSuffix`.
- `packages/nax-agent/src/tools/runtime-calltool.ts`: `resolveAskOutcome(p)`, which appends `p.unsandboxed.suffix` to the reason and sets `unsandboxed: true` on the ask request.
- `packages/nax-agent/src/tools/truncate.ts`: `MODEL_MAX_BYTES` (40,000), `MODEL_MAX_LINES` (1,000), `truncationDirectionFor`, `splitModelLines`.
- `packages/nax-agent/src/web/content.ts`: `fenceWebContent({ source, fetchedAt, text })`. Its output is `<web-content source="…" fetched="…" untrusted="true">`, a newline, the text, a newline, then `</web-content>`.
- `packages/nax-agent/src/sandbox/placeholder-deps.ts`: `_placeholderDeps.platform()`, `_placeholderDeps.ledgerDir()`.
- `packages/nax-agent/src/sandbox/placeholder-paths.ts`: `placeholderIdentity(path)`.
- `packages/nax/src/prompts/builders/background-builder.ts`: `buildBackgroundTaskNotice`.
- `packages/nax/src/chat/mentions/mention-envelope.ts`: `parseMentionMessage(message)`.
- `@nathapp/nax-agent/internal`: `extractWebUrls(text)`.
- `packages/nax/src/advisor/ledger.ts`: `ledgerPath(repoRoot, feature)`.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

**US-001 (nax-agent memory)**

- `MemoryOutboxEntry` and the outbox's `OutboxRequest` (`packages/nax-agent/src/memory/outbox.ts`).
  - Baseline: `MemoryWriteRequest & { seq; enqueuedAt; state; reason?; requestReason?; badResponses?; lastError? }`. `EntrySchema` has no dependency field.
  - Target: both gain `readonly awaits?: string`, the client id of an entry this one must not be delivered before. `EntrySchema` gains `awaits: z.string().regex(MEMORY_CLIENT_ID_RE).optional()`. `enqueue` refuses an `awaits` that does not match `MEMORY_CLIENT_ID_RE` with `MEMORY_CLIENT_ID_INVALID`, before any file is written. `awaits` is queue bookkeeping: `requestOf` (`sync-drain.ts`) never copies it onto the `MemoryWriteRequest` a provider receives.
- `drainOutbox` (`packages/nax-agent/src/memory/sync-drain.ts`).
  - Baseline: pushes every `queued` entry in `seq` order. A permanent rejection is marked and the drain continues; a transient failure stops it.
  - Target: before pushing a queued entry that carries `awaits`, the drain reads the outbox's current state of the awaited id. When the awaited entry is `rejected`, the entry is marked `rejected` without being pushed, with reason `not sent: the replacement it waits on (<awaited slug>) was refused`, and counted in `rejected`. The entry's scope's pull cursor is then rewound with `rewindPullCursor(store, scope)`, as `park` does, so the next pull writes the unsent source back to the mirror (a rejected entry holds no key). When the awaited entry is still `queued`, the entry is not pushed and not counted. When the outbox no longer holds the awaited id, the entry is pushed as before. `proveAndPark` never chooses as its proof an entry whose `awaits` names an entry the outbox still holds.
- `stageAndRecord`, `stageMerge`, `retireMergeSources` (`packages/nax-agent/src/memory/compaction-apply.ts`).
  - Baseline: `retireMergeSources(input, merge)` enqueues each source forget with no relation to the merge's save.
  - Target: each merge's source forgets are enqueued with `awaits` set to the client id of that merge's save (the merged note's id). A plan `retire` is enqueued without `awaits`.
- `validateMemoryNoteWrite` (`packages/nax-agent/src/memory/validate.ts`).
  - Baseline: `bodyRefusal(body)` refuses only a body over `MEMORY_NOTE_BODY_MAX_BYTES`.
  - Target: a body that holds no non-whitespace character is refused first, with `{ field: "body", reason: "body must not be blank" }`. The size check follows. `validateMemoryCompactionPlan` inherits this through `writeReasons`.

**US-002 (nax-agent tools)**

- `ToolRunContext` (`packages/nax-agent/src/tools/registry.ts`).
  - Target: gains `readonly fullNetworkUnwrapped?: boolean`: the runtime's one decision about whether a `network: "full"` Bash call runs outside the sandbox.
- `UNSANDBOXED_PREFIX` (`packages/nax-agent/src/tools/ask-request.ts`).
  - Baseline: a module-private constant `"; runs OUTSIDE the sandbox: "`.
  - Target: exported, unchanged in value.
- A new file `packages/nax-agent/src/tools/runtime-full-network.ts` exports:
  - `fullNetworkUnwrapped(identity: string, input: Record<string, unknown>, port: WebExposurePort | undefined): boolean`. It returns true only when `identity` is `BASH_TOOL_NAME`, `input.network === "full"` and `port?.exposedNetwork?.() !== undefined`.
  - `FULL_NETWORK_UNSANDBOXED_SUFFIX`, built from `UNSANDBOXED_PREFIX` followed by `full network requested`, so it renders `"; runs OUTSIDE the sandbox: full network requested"`.
  - `resolveCallSandbox(p: { identity: string; tool: CodingTool; input: Record<string, unknown>; opts: { readonly unsandboxed?: …; readonly webExposure?: WebExposurePort } }): { readonly call?: UnsandboxedCall; readonly askOption: { readonly unsandboxed?: { readonly suffix: string } }; readonly fullNetworkUnwrapped: boolean }`. It reads `opts.unsandboxed` and `opts.webExposure` itself, so the call site fits on one line. The fields:
    - `call` is exactly what `resolveUnsandboxedCall` answers today, including its `{ kind: "error" }` variant. Only `call` feeds `resolveAskVerdict` and the error return, so the allow-to-ask conversion of an explicit `unsandboxed: true` request (`convertUnsandboxedAllow`) is unchanged.
    - `askOption` is the spread object every ask route receives. It is `{ unsandboxed: { suffix: call.suffix } }` when `call` is the `unsandboxed` variant, else `{ unsandboxed: { suffix: FULL_NETWORK_UNSANDBOXED_SUFFIX } }` when `fullNetworkUnwrapped` is true, else `{}`. A full-network call never becomes an `UnsandboxedCall`, so it is never converted from allow to ask with the "unsandboxed run requested" reason.
- `createCodingToolRuntime(...).callTool` (`packages/nax-agent/src/tools/runtime.ts`).
  - Baseline: exposure is read by the guard when the ask is raised, and again by Bash at launch. `resolveUnsandboxedCall(...)` is called at line 385, and the policy-ask route spreads `unsandboxed` at line 524.
  - Target: `callTool` calls `resolveCallSandbox({ identity: policyIdentity, tool, input, opts })` once, before the policy check, in place of the `resolveUnsandboxedCall` call. `call` keeps today's error branch and `resolveAskVerdict` input. The policy-ask route's spread becomes `...sandbox.askOption`. The guard-denial route (`resolveWebAwareAskOutcome`) and `resolveWebExposureDenial` also receive `...sandbox.askOption`, and `resolveWebExposureDenial` gains an optional `unsandboxed` parameter it forwards to `resolveAskOutcome`. `runTool` passes `fullNetworkUnwrapped` on the `ToolRunContext`.
  - Line budget: `runtime.ts` must end at 600 lines or fewer (it is 599). The additions above are about +4 lines. To pay for them, the first `resolveWebAwareAskOutcome` route's argument list (the policy-ask route, about 15 lines around line 508) moves into a helper `askThroughGuard(...)` in `runtime-full-network.ts`, which takes the same values and returns that call's promise. `bun run check:file-sizes` passes with the baseline unchanged.
  - A consequence to note: an ask carrying `unsandboxed: true` is never auto-decided (`session-ask-port.ts`), so in a full-mode chat an exposed `network: "full"` Bash call now always waits for a human.
- `requestsUnwrapped` (`packages/nax-agent/src/tools/bash.ts`).
  - Baseline: `input.unsandboxed === true || (input.network === "full" && opts.fullNetwork?.isExposed() === true)`.
  - Target: `input.unsandboxed === true || (input.network === "full" && (ctx.fullNetworkUnwrapped ?? opts.fullNetwork?.isExposed() === true))`. The context's decision wins when present; a direct call without one keeps today's behaviour.

**US-003 (nax-agent web and truncation)**

- `fetchTool` (`packages/nax-agent/src/web/provider.ts`).
  - Target: the provider tool declares `summaryFields: ["url"]`.
- `send` (`packages/nax-agent/src/web/search-request.ts`).
  - Baseline: `_webSearchDeps.fetch(request.url, { ...request.init, signal })`.
  - Target: `_webSearchDeps.fetch(request.url, { ...request.init, redirect: "manual", signal })`. A 3xx then reaches `assertStatus` and throws `WEB_SEARCH_FAILED` with message `<backend> search failed with status <status>` and context `{ backend, status }`.
- `packages/nax-agent/src/web/content.ts` exports `WEB_CONTENT_CLOSE_LINE = "</web-content>"`, and `fenceWebContent` uses it. `content.ts` keeps importing nothing, so `tools/spill.ts` may import it without a cycle.
- `composeHead` / `applyModelTruncationPolicy` (`packages/nax-agent/src/tools/spill.ts`).
  - Baseline: the head direction keeps the shaped head and a marker line, so a fence's closing line is cut with the rest.
  - Target: when the head direction truncates a body whose first line starts with `<web-content ` and which has a **web trailer**, the result ends with the marker line followed by that trailer. The trailer is the last line equal to `WEB_CONTENT_CLOSE_LINE` plus every line after it, provided at most one line follows it (the fetch tool's `[truncated at <n> bytes]` line). The trailer is taken from the original `body`, before `truncateForModel` runs, because `shaped.content` has already lost it. Its bytes and lines are reserved from the same byte cap and `MODEL_MAX_LINES` before the head is cut. Every other body is shaped exactly as today.

**US-004 (nax-agent sandbox)**

- `stagingPlaceholderPaths(cwd, trackedPaths)` (`packages/nax-agent/src/sandbox/staging-placeholders.ts`).
  - Target: the `SRT_MANDATORY_DENY_FILES` / `SRT_MANDATORY_DENY_DIRS` sources are used only when `_placeholderDeps.platform()` is `"linux"`. The ledger entries are used on every platform, as today (a ledger exists only on Linux).
- `replaceAtomically(path, content, mode)` (`packages/nax-agent/src/sandbox/placeholder-excludes.ts`).
  - Target: when `mode` is defined, the temp file is `chmod`ed to `mode` after it is written and before the rename, so the result carries the original permission bits regardless of the umask.
- `PlaceholderLedger.prune` (`packages/nax-agent/src/sandbox/placeholder-ledger.ts`).
  - Baseline: `prune(): void` drops identified entries whose inode is gone and keeps every pending entry.
  - Target: `prune(opts?: { readonly abandonPending?: boolean }): void`. With `abandonPending: true` the pending entries are dropped too. Without the option, behaviour is unchanged.
- The srt backend (`packages/nax-agent/src/sandbox/srt-backend.ts`).
  - Target: it counts wraps in flight. The count goes up where `recordPlaceholderCandidates` runs for a wrap. It goes down in `commandFinished`, and also when `wrapWithSandboxArgv` throws after the candidates were recorded, because a failed wrap is never followed by `commandFinished`. It never goes below 0. `commandFinished` calls `prune({ abandonPending: true })` when that count reaches 0, and `prune()` otherwise. `reset()` calls `prune({ abandonPending: true })` and sets the count to 0.

**US-005 (nax chat)**

- `ChatSendOptions` (`packages/nax/src/chat/chat-host-types.ts`).
  - Target: gains `readonly automatic?: boolean`: a host-generated turn (a background-task or job notice), whose text is never recorded as seen URLs.
- `ChatHost.steer` (`chat-host-types.ts`, `chat-host.ts`, `createHostSteering` in `host-steer-compact.ts`).
  - Baseline: `steer?(text: string): SteerResult`.
  - Target: `steer?(text: string, options?: { readonly automatic?: boolean }): SteerResult`. When the session answers `accepted` and `options?.automatic !== true`, the URLs in the typed text are recorded on the open handle's web exposure. `HostSteerInput` gains `readonly web: () => ChatWeb | undefined`, which `NativeChatHost` supplies from its open handle, and `createHostSteering` does the recording, so `chat-host.ts` only forwards `options`. A typed steer is called with one argument (`steer(text)`), never with an explicit `undefined` second argument.
- A new export `recordTypedUrls(web: ChatWeb | undefined, message: string): void` in `packages/nax/src/chat/session-web.ts` holds the one recording rule: `web.exposure.recordUrls(extractWebUrls(parseMentionMessage(message)?.text ?? message))`, and nothing when `web` is undefined.
- `wrapWebSession` (`session-web.ts`).
  - Baseline: `send` calls `web.exposure.recordUrls(...)` before delegating.
  - Target: `send` no longer records. It keeps its drain-around-events behaviour.
- `NativeChatHost.send` (`packages/nax/src/chat/chat-host.ts`).
  - Target: when `options?.automatic !== true`, it calls `recordTypedUrls(this.handle.web, message)` synchronously, after the `CHAT_TURN_BUSY` rejection (a rejected send records nothing) and before the turn's `handle.session.send` is called. `chat-host.ts` stays at 600 lines or fewer.
- `ChatApp` job and task notice delivery (`packages/nax/src/tui/chat/ChatApp.tsx`, `use-jobs.ts`).
  - Baseline: `deliver: (text) => sendTurn({ message: text })`. `sendTurn` → `sendMessage` calls `host.send(message, onEvent)` with no options when `message === title`. `ComposedSend` has no origin field. `useTaskNoticeSteer` calls `host.steer(notice)`.
  - Target: `ComposedSend` gains `readonly automatic?: boolean`. `deliver` passes `sendTurn({ message: text, automatic: true })`. `sendMessage` adds `automatic: true` to the options it passes `host.send` exactly when the composed send carries it, so a notice reaches `host.send(text, onEvent, { automatic: true })` with no `title`. A steered notice calls `host.steer(notice, { automatic: true })`. A typed message and a typed steer are unchanged: no `automatic`.

**US-006 (nax memory)**

- `createKodaMemoryProvider` (`packages/nax/src/memory/koda-provider.ts`).
  - Baseline: returns `MemoryProvider`.
  - Target: returns `KodaMemoryProvider = MemoryProvider & { effectiveWriteMode(): Promise<"direct" | "proposal"> }`. `effectiveWriteMode` reads `GET projects/<project>/memory/write-mode` on every call, with no memo, because a policy change on Koda must be seen. It resolves `data.mode` when it is `direct` or `proposal`. Otherwise it throws `NaxError` `MEMORY_KODA_BAD_RESPONSE`, and a client failure propagates unchanged.
- A new export `effectiveWriteModeOf(provider: MemoryProvider): (() => Promise<"direct" | "proposal">) | undefined` in `koda-provider.ts` answers the method when the provider has one.
- `HostCompactionInput` and `createHostCompaction` (`packages/nax/src/memory/host-compact.ts`).
  - Baseline: `{ …; providerId: string; writeMode: "direct" | "proposal"; … }`; apply and undo refuse only on the local `writeMode`.
  - Target: `providerId: string` is replaced by `provider: MemoryProvider`, and the manifest's provider label reads `provider.id`. Apply and undo refuse with `MEMORY_COMPACT_UNSUPPORTED` when the local `writeMode` is `proposal`, or when `effectiveWriteModeOf(input.provider)` exists and resolves `proposal`. A rejected lookup propagates, and no operation is called. `createMemoryHost` (`host.ts`) passes `provider: parts.provider` in place of `providerId: parts.provider.id`, so `host.ts` does not grow.

**US-007 (nax bot)**

- `commitExactText` / `refreshIndexEntry` (`packages/nax/src/bot/ledger-carry.ts`).
  - Baseline: after `update-ref`, `refreshIndexEntry` resets the ledger's index entry to HEAD unconditionally.
  - Target: `refreshIndexEntry` receives the parent commit's blob for `rel`, looked up in `commitExactText` with `git rev-parse <parent>:<rel>` (a failure means the file was absent), and the new commit's `blob`. After `update-ref`, it reads the user's current index entry blob for `rel` (`git ls-files -s -- :(literal)<rel>` against the real index). It resets the entry to HEAD only when that blob equals the parent's blob or the new commit's blob, or when the entry and the parent's blob are both absent. Otherwise it leaves the index alone and warns `Advisor ledger committed; the staged ledger differs and was left as is`. When the index read fails, it skips the reset with the same warn.
- `carry` (`ledger-carry.ts`).
  - Baseline: when `isLedgerAppend(previous, main)` is false, it warns "Main checkout ledger does not extend the PR's; not carried" and returns false.
  - Target: a new exported `mergedLedgerText(previous: string | null, main: string): string | null`.
    - It answers `main` when `isLedgerAppend(previous, main)` holds, `previous` is `null`, empty or ends in a newline, and `main` ends in a newline. A character-level append onto an unterminated last line, or one that ends in an unterminated line, goes to the line merge below instead.
    - Otherwise it answers `previous`, with a newline added when it lacks a trailing one, followed by every **complete** line of `main` that `previous` does not hold, in main's order, each ending in a newline. A complete line is a non-empty line followed by a newline, so an unterminated last line of `main` is never carried.
    - "`previous` holds a line" means the line equals one of previous's lines, its unterminated last line included. A line repeated in `main` is carried once. `previous = null` is an empty prefix.
    - It answers `null` when no complete line is missing.
  - `carry` commits that text with the existing add-and-commit path. `null` always means no carry: `carry` warns "Main checkout ledger does not extend the PR's; not carried" and returns false with no commit. This includes `previous = "a\n"` with `main = "a\nb"`, which today commits `"a\nb"` and now waits until main's last line is complete. The PR's own lines are never reordered or removed.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| A merge's save is refused permanently (US-001) | Its source forgets are marked `rejected` and never pushed; the sources stay active on the provider. |
| A merge's save fails transiently (US-001) | The drain stops at the save, as today; its forgets stay queued for the next sync. |
| An awaiting entry whose awaited entry is gone from the outbox (US-001) | Pushed as an ordinary entry. |
| The Koda write-mode lookup fails before apply or undo (US-006) | The error propagates; no operation runs and nothing is staged. |
| The user's index entry cannot be read before the in-place commit (US-007) | The commit proceeds and the index refresh is skipped with the warn above. |
| A placeholder candidate's wrap never finishes (US-004) | Its pending entries are abandoned at `reset()`. |

## Out of Scope

- US-001 only: a merge whose save the provider answers as `pending` (a Koda proposal) still delivers its source forgets after it; compaction under Koda proposal mode is refused up front by US-006.
- US-001 only: compaction undo keeps queuing its removal of a merged note without waiting on the restores it queues.
- US-001 only: entries queued before this feature carry no `awaits` and drain as before; no migration rewrites them.
- US-001 only: the local mirror is not rewritten by the drain itself after a refused replacement; the unsent sources come back through the next pull, after the cursor rewind.
- US-001 only: requeuing a refused save with `outbox.requeue` does not revive the forgets that were rejected while waiting on it; they stay rejected until requeued themselves.
- US-002 only: `Exec` has no `network` input and is unchanged.
- US-003 only: a truncated web result is not re-fetchable by offset; the spill file remains the only copy of the cut text.
- US-003 only: tail-direction truncation (Bash and other command tools) is unchanged.
- US-004 only: ledgers already written by earlier versions are not rewritten; their pending entries are dropped at the next abandon point of this process or by the existing sweep.
- US-005 only: URLs pasted into a slash command's arguments are recorded exactly as a typed message is today.
- US-007 only: a PR ledger line that the main ledger also holds, at a different position, is not moved.
- The remaining review notes (#8 intentional saved-fix invalidation, #9 withdrawn) need no change.

## Stories

**US-001: a merge's source retirements wait on its replacement (#3052).** Workdir: `packages/nax-agent`. No dependencies. Adds the outbox `awaits` field and the drain rule, sets it for merge sources, and refuses a blank note body.

**US-002: a full-network Bash call is approved and launched as unsandboxed, decided once (#3053).** Workdir: `packages/nax-agent`. No dependencies. Adds `fullNetworkUnwrapped`, the ask suffix and the run-context decision Bash reads.

**US-003: the fetch approval names its URL, search fails on a redirect, and web truncation keeps the closing fence (#3060, #3062, #3063).** Workdir: `packages/nax-agent`. No dependencies.

**US-004: placeholder ledgers, staging exclusions and exclude-file modes are correct per platform (#3055, #3059, #3061).** Workdir: `packages/nax-agent`. No dependencies.

**US-005: only text a person typed is recorded as seen URLs (#3054).** Workdir: `packages/nax`. No dependencies. Moves recording from the session wrapper to `ChatHost.send` and an accepted `ChatHost.steer`, and marks notice turns `automatic`.

**US-006: compaction refuses under Koda's effective proposal mode (#3056).** Workdir: `packages/nax`. No dependencies.

**US-007: the bot ledger keeps a user-staged version and carries divergent main entries (#3057, #3058).** Workdir: `packages/nax`. No dependencies.

### Context Files

**US-001**
- `packages/nax-agent/src/memory/compaction-apply.ts` — `stageAndRecord`, `stageMerge`, `retireMergeSources`, `retireSlug`
- `packages/nax-agent/src/memory/sync-drain.ts` — `drainOutbox`, `settle`, `proveAndPark`, `requestOf`
- `packages/nax-agent/src/memory/outbox.ts` — `MemoryOutboxEntry`, `EntrySchema`, `enqueue`, `markRejected`
- `packages/nax-agent/src/memory/validate.ts` — `validateMemoryNoteWrite`, `bodyRefusal`
- `packages/nax-agent/test/helpers/memory-provider.ts` — `makeMemoryProvider` scripted push

**US-002**
- `packages/nax-agent/src/tools/runtime.ts` — `callTool`, `runTool`, the three web-aware ask routes
- `packages/nax-agent/src/tools/bash.ts` — `requestsUnwrapped`, `createBashTool`
- `packages/nax-agent/src/tools/runtime-web-guard.ts` — `resolveWebAwareAskOutcome`, `resolveWebExposureDenial`
- `packages/nax-agent/test/unit/tools/bash-full-network.test.ts` — the fake launcher capturing `unwrapped`
- `packages/nax-agent/test/integration/web/network-runtime.test.ts` — the exposed session fixture

**US-003**
- `packages/nax-agent/src/web/provider.ts` — `fetchTool`, `createWebToolProvider`
- `packages/nax-agent/src/web/search-request.ts` — `send`, `assertStatus`, `_webSearchDeps`
- `packages/nax-agent/src/tools/spill.ts` — `applyModelTruncationPolicy`, `composeHead`
- `packages/nax-agent/src/web/content.ts` — `fenceWebContent`
- `packages/nax-agent/test/unit/web/search-backend-exa-searxng.test.ts` — the SearXNG fetch stub

**US-004**
- `packages/nax-agent/src/sandbox/staging-placeholders.ts` — `stagingPlaceholderPaths`
- `packages/nax-agent/src/sandbox/placeholder-excludes.ts` — `replaceAtomically`, `ensurePlaceholderExcludes`
- `packages/nax-agent/src/sandbox/placeholder-ledger.ts` — `createLedger`, `prune`, `readLedgerFile`
- `packages/nax-agent/src/sandbox/srt-backend.ts` — `recordPlaceholderCandidates`, `commandFinished`, `reset`
- `packages/nax-agent/test/unit/sandbox/placeholder-ledger.test.ts` — the ledger fixtures over `_placeholderDeps`

**US-005**
- `packages/nax/src/chat/session-web.ts` — `wrapWebSession`, `persistSessionWeb`
- `packages/nax/src/chat/chat-host.ts` — `NativeChatHost.send`, `steer`
- `packages/nax/src/chat/host-steer-compact.ts` — `createHostSteering`
- `packages/nax/src/tui/chat/use-jobs.ts` — `useTaskNoticeSteer`, the `deliver` option
- `packages/nax/test/ui/chat/task-notices.test.tsx` — the `mount` helper with `send` and `steer` mocks

**US-006**
- `packages/nax/src/memory/host-compact.ts` — `createHostCompaction`, `apply`, `undo`, `unsupported`
- `packages/nax/src/memory/koda-provider.ts` — `createKodaMemoryProvider`, `reachable`, `KODA_WRITE_MODES`
- `packages/nax/src/memory/host.ts` — `createMemoryHost`, `composeKoda`
- `packages/nax/test/integration/memory/host-compaction.test.ts` — the host compaction fixture
- `packages/nax/test/unit/memory/koda-provider-save.test.ts` — the scripted Koda client

**US-007**
- `packages/nax/src/bot/ledger-carry.ts` — `carry`, `commitExactText`, `refreshIndexEntry`, `isLedgerAppend`
- `packages/nax/test/unit/bot/ledger-carry.test.ts` — `_ledgerCarryDeps` fixtures
- `packages/nax/test/integration/bot/ledger-in-place.test.ts` — the real-repository in-place runs
- `packages/nax/test/integration/bot/ledger-carry.test.ts` — the main and PR worktree fixture

### Creates

**US-001**
- `packages/nax-agent/test/unit/memory/sync-drain-awaits.test.ts` — drain tests for `awaits` (US-001 ACs 5-11, 17, 18)
- `packages/nax-agent/test/integration/memory/compaction-refused-replacement.test.ts` — apply plus drain end to end (US-001 ACs 1-2, 12-13); ACs 3-4 extend `outbox.test.ts` and ACs 14-16 extend `validate.test.ts`

**US-002**
- `packages/nax-agent/src/tools/runtime-full-network.ts` — `fullNetworkUnwrapped`, `FULL_NETWORK_UNSANDBOXED_SUFFIX`
- `packages/nax-agent/test/unit/tools/runtime-full-network.test.ts` — runtime-level tests (US-002 ACs 1-7); ACs 8-10 extend `packages/nax-agent/test/unit/tools/bash-full-network.test.ts`

**US-003**
- `packages/nax-agent/test/unit/tools/spill-web-fence.test.ts` — truncation tests for fenced web results (US-003 ACs 6-11)

**US-004**
- `packages/nax-agent/test/unit/sandbox/srt-backend-ledger-abandon.test.ts` — backend abandon-point tests (US-004 ACs 8-12)

**US-005**
- `packages/nax/test/unit/chat/chat-host-web-urls.test.ts` — recording through `ChatHost.send` and `steer` (US-005 ACs 1-6)

**US-006**
- `packages/nax/test/unit/memory/host-compact-koda-mode.test.ts` — host compaction refusal tests (US-006 ACs 4-9)

**US-007**

None. The ACs extend the existing ledger-carry unit and integration files.

### Modifies

**US-001**

None. Existing outbox, drain and compaction tests hold no `awaits` entry, and none assert a merge-source forget's full key set.

**US-002**
- `packages/nax-agent/test/integration/web/network-runtime.test.ts` — the assertion that the full-network ask's `reason` is exactly `"full network after this session read web content"` now sees the unsandboxed suffix. The invariant becomes: `reason` equals `"full network after this session read web content; runs OUTSIDE the sandbox: full network requested"`, and the request carries `unsandboxed: true`.

**US-003**

None. No existing test fences a web result past the truncation caps, and no search test answers a 3xx.

**US-004**
- `packages/nax-agent/test/unit/sandbox/staging-placeholders.test.ts` — the tests that expect a mandatory-name placeholder (such as the MCP config file) to be returned now set `_placeholderDeps.platform = () => "linux"` in their setup. The invariant becomes: mandatory names are returned on Linux, and the darwin case returns none (US-004 AC 1).
- `packages/nax-agent/test/unit/internal/git-add.test.ts` — the "with a placeholder in the tree (US-006)" describe now sets `_placeholderDeps.platform = () => "linux"`, so its exclude-per-placeholder assertions keep testing the Linux behaviour on a macOS host.
- `packages/nax-agent/test/integration/sandbox/staging-placeholders-git-add.test.ts` — its placeholder fixtures now set `_placeholderDeps.platform = () => "linux"`, so a mandatory-name placeholder is still excluded from `git add` when the suite runs on macOS.
- `packages/nax-agent/test/unit/tools/git-commit.test.ts` — "AC-9: the commit holds notes.md and not the 0444 empty .mcp.json" creates an empty 0444 MCP config file and expects `gitCommitTool` not to commit it. Its describe "gitCommitTool — a placeholder is never committed (US-006)" now sets `_placeholderDeps.platform = () => "linux"`, so it keeps pinning the Linux exclusion on a macOS host.
- `packages/nax-agent/test/unit/sandbox/policy-builder-root-denies.test.ts` — its `stagingPlaceholderPaths` assertions now set `_placeholderDeps.platform = () => "linux"`, so they keep pinning the Linux exclusion on a macOS host.
- `packages/nax-agent/test/unit/sandbox/srt-backend.test.ts` — "US-003 AC5: a .bashrc the user wrote before the first wrap never enters the ledger" asserts that `.zprofile` is still listed by `ledgerPaths()` after two wrap-and-finish pairs. With no wrap left in flight, `.zprofile` was pending and is now abandoned. The invariant becomes: `.bashrc` never enters the ledger, and `.zprofile` is listed while a wrap is in flight (asserted before the last `commandFinished`).

**US-005**
- `packages/nax/test/unit/chat/open-chat-session-web.test.ts` — "AC-9 typed URL is seen synchronously before send starts" asserts that `handle.session.send` records the URL. The invariant moves to `ChatHost.send` (US-005 AC 1). This test now asserts that `handle.session.send` alone records nothing and still forwards its message and input unchanged.
- `packages/nax/test/unit/chat/open-chat-session-web.test.ts` — "AC-10 URLs inside attached files are not pre-approved" drives `handle.session.send`. It now drives `ChatHost.send`, with the same expectation that `seenUrls` stays empty.

**US-006**
None. `host-compaction.test.ts` builds its host through `createMemoryHost` over the local provider, whose `id` is still the operation's `provider` label, and no test builds `createHostCompaction` input by hand.

**US-007**
- `packages/nax/test/unit/bot/ledger-carry.test.ts` — "AC-5–8: %s main ledger is not carried" runs `equal`, `missing`, `divergent` and `shorter` and expects no carry for each. The `divergent` case (main `"other\nnew\n"` against PR `"old\n"`) is now carried: the PR ledger becomes `"old\nother\nnew\n"`, with no warn. The `equal`, `missing` and `shorter` cases keep their current expectations; `shorter` (main `"ol"`, no complete line) still skips with the same warn.

### Seams

- US-001's `awaits` is produced by `applyMemoryCompaction` and consumed by `drainOutbox` in the same story. ACs 12-13 drive both through their public entries, with no stub between them.
- US-002's `fullNetworkUnwrapped` is consumed by `callTool` and, through `ToolRunContext`, by Bash. AC 4 enters at `createCodingToolRuntime(...).callTool` with a real Bash tool and a fake launcher, so the context hand-off is exercised.
- US-005's `automatic` option is produced by `ChatApp` and `useTaskNoticeSteer` and consumed by `ChatHost`. ACs 7-9 enter at the background task's completion in a mounted `ChatApp`, and assert the host received `automatic: true`.
- US-006's `effectiveWriteModeOf` is consumed by `createHostCompaction`. AC 9 enters at `createMemoryHost` with a Koda client stub, so the `provider` hand-off in `host.ts` is exercised.

## Acceptance Criteria

ACs marked **(control)** already pass on the baseline code and pin behaviour that must not regress; every other AC fails on the baseline.

### US-001

Setup: a mirror holding project notes `budget-a` and `budget-b`, a plan merging `["budget-a", "budget-b"]` into a slug, a `makeMemoryProvider` whose `push` throws `NaxError` `MEMORY_PUSH_REJECTED` for a `save` and answers `{ id, status: "deleted" }` for a `forget`.

1. [unit] After `applyMemoryCompaction` merges into `budget-a`, the queued forget for `budget-b` carries `awaits` equal to the `clientId` of the queued save for `budget-a`.
2. [unit] After `applyMemoryCompaction` with a plan that retires `stale-note`, the queued forget for `stale-note` has no `awaits`.
3. [unit] `outbox.enqueue({ kind: "forget", …, awaits: "not a client id!" })` rejects with `NaxError` code `MEMORY_CLIENT_ID_INVALID`, and `outbox.list()` stays empty.
4. [unit] An entry enqueued with `awaits` is listed with the same `awaits` by a second `createMemoryOutbox` opened over the same directory.
5. [unit] `drainOutbox` over a rejected save and a queued forget awaiting it never passes the forget to `provider.push`.
6. [unit] In that case the forget's state is `rejected`, with reason `not sent: the replacement it waits on (budget-a) was refused`.
7. [unit] In that case `drainOutbox` returns `{ pushed: 0, rejected: 2 }` (the save and the forget), with no `failure`.
8. [unit] (control) When the provider accepts the save, `provider.push` receives the save and then the awaiting forget, in that order, and both entries leave the outbox.
9. [unit] A forget whose awaited save the outbox already holds as `rejected` from an earlier drain is marked `rejected` by the next `drainOutbox` without being pushed.
10. [unit] A forget whose awaited client id the outbox no longer holds is pushed by `drainOutbox`.
11. [unit] When the awaited save has met `MEMORY_PUSH_MAX_BAD_RESPONSES` bad responses and its awaiting forget is the only other queued entry, `drainOutbox` does not push the forget, does not park the save, and returns a `failure`.
12. [integration] `applyMemoryCompaction` merging into `budget-a`, then `drainOutbox` with the refusing provider, sends only `save:budget-a` to `provider.push`.
13. [integration] A plan whose merged body is `"   "` is refused by `applyMemoryCompaction` with `MEMORY_COMPACT_PLAN_INVALID`, and the outbox stays empty.
14. [unit] `validateMemoryNoteWrite` with body `"  \n\t"` returns `{ field: "body", reason: "body must not be blank" }`.
15. [unit] `validateMemoryCompactionPlan` for a merge into `budget-merged` with body `" "` returns a reason equal to `merge target "budget-merged": body must not be blank`.
16. [unit] (control) `validateMemoryNoteWrite` with body `"x"` and otherwise valid fields returns `null`.
17. [unit] The `MemoryWriteRequest` that `provider.push` receives for an entry carrying `awaits` has no `awaits` key.
18. [unit] When `drainOutbox` marks an awaiting forget `rejected` because its save was refused, the project scope's pull cursor is rewound, so the next `pull` call asks the provider with `cursor: null`.

### US-002

Setup for ACs 1-7: `createCodingToolRuntime` with a real `createBashTool({ fullNetwork })` over a fake launcher recording each request's `unwrapped`, an `askResolver` recording each request, and a `webExposure` port whose `exposedNetwork` the test controls. `fullNetwork` is built from the same port.

1. [unit] With the port exposed, `callTool("Bash", { command: "echo hi", network: "full" })` raises an ask whose request carries `unsandboxed: true`.
2. [unit] In that case the request's `reason` equals `full network after this session read web content; runs OUTSIDE the sandbox: full network requested`.
3. [unit] In that case, after the ask is approved, the launcher receives `unwrapped: true`.
4. [unit] For `callTool("Bash", { command: "echo hi", network: "full" })` with a policy whose Bash rule answers `ask` for `echo hi`, the port unexposed when `callTool` starts, and the port exposed by the `askResolver` before it approves that policy ask, the approved call launches with `unwrapped: false`.
5. [unit] For `callTool("Bash", { command: "echo hi", network: "full" })` with the port exposed when `callTool` starts, and unexposed by the `askResolver` before it approves, the approved call launches with `unwrapped: true`.
6. [unit] (control) With the port exposed, `callTool("Bash", { command: "echo hi" })` with no `network` input raises no request carrying `unsandboxed: true`.
7. [unit] `fullNetworkUnwrapped("Exec", { network: "full" }, exposedPort)` returns `false`.
8. [unit] Bash's `run` called directly with `{ command: "echo hi", network: "full" }`, `fullNetwork.isExposed()` false and run context `fullNetworkUnwrapped: true` launches with `unwrapped: true`.
9. [unit] Bash's `run` with `fullNetwork.isExposed()` true and run context `fullNetworkUnwrapped: false` launches with `unwrapped: false`.
10. [unit] (control) Bash's `run` with `fullNetwork.isExposed()` true and no `fullNetworkUnwrapped` in the run context launches with `unwrapped: true`.

### US-003

1. [unit] `askSummary("web__fetch", scope, { url: "https://docs.example.com/guide" })`, with the scope of the adapted fetch tool from `createWebToolProvider`, returns summary `web__fetch url=https://docs.example.com/guide`.
2. [integration] In an exposed session, `callTool("web__fetch", { url: "https://unseen.example/page" })` raises an ask whose `summary` equals `web__fetch url=https://unseen.example/page`.
3. [unit] A SearXNG search whose `_webSearchDeps.fetch` stub answers status 302 with a `location` header rejects with `NaxError` code `WEB_SEARCH_FAILED` and context `status: 302`.
4. [unit] In that case the rejection's message equals `searxng search failed with status 302`.
5. [unit] Every backend's request reaches `_webSearchDeps.fetch` with `redirect: "manual"` in its init.
6. [unit] `applyModelTruncationPolicy` over `fenceWebContent` of a 1,103-line text, with `toolName: "web__fetch"`, returns a result whose last line is `</web-content>`.
7. [unit] In that case the result has at most `MODEL_MAX_LINES` lines.
8. [unit] In that case the line before `</web-content>` is the truncation marker, which starts with `... [truncated`.
9. [unit] With `maxBytes: 4000` and a fenced 200 KB single-paragraph text, the result's UTF-8 byte length is at most 4000 and its last line is `</web-content>`.
10. [unit] A fenced body followed by a `[truncated at 2000000 bytes]` line, cut by the policy, ends with `</web-content>` and then `[truncated at 2000000 bytes]` as its last two lines.
11. [unit] (control) A body whose first line is `<project>` and whose last line is `</project>`, cut by the head direction, ends with the truncation marker as its last line.

### US-004

1. [unit] With `_placeholderDeps.platform` answering `"darwin"`, `stagingPlaceholderPaths(cwd, [])` over a directory holding an empty, mode-0444 `.mcp.json` returns `[]`.
2. [unit] (control) With `_placeholderDeps.platform` answering `"linux"`, the same call returns `[".mcp.json"]`.
3. [integration] With `_placeholderDeps.platform` answering `"darwin"`, `gitlinkSafeAdd` over a fresh repository holding an untracked, empty, mode-0444 `.mcp.json` stages it, and `git ls-files` lists `.mcp.json`.
4. [unit] Under `process.umask(0o022)`, `ensurePlaceholderExcludes(cwd)` over a repository whose `.git/info/exclude` has mode `0664` leaves the file at mode `0664`.
5. [unit] (control) In that case the exclude file ends with every `PLACEHOLDER_EXCLUDE_ENTRIES` line.
6. [unit] A ledger that `recordAbsent`ed one path, then `prune({ abandonPending: true })`, leaves no ledger file on disk.
7. [unit] (control) A ledger that `recordAbsent`ed one path, then `prune()`, still lists that path as a pending entry in `readLedgerFile`.
8. [unit] With two wraps in flight, the first `commandFinished` leaves the pending entry in the ledger file.
9. [unit] In that case, the second `commandFinished` removes the pending entry from the ledger file.
10. [unit] After the last `commandFinished` abandons a pending path, a user creates an empty, mode-0444 file at that path. After a later `placeholderLedger().observe()` with no new wrap, no ledger file in the ledger directory lists that path.
11. [unit] `reset()` with one wrap in flight removes that wrap's pending entries from the ledger file.
12. [unit] When one wrap's `wrapWithSandboxArgv` throws and another wrap then runs to its `commandFinished`, that `commandFinished` removes the pending entries from the ledger file.

### US-005

Setup for ACs 1-6: a `NativeChatHost` over a web-enabled native handle (as `open-chat-session-web.test.ts` builds it) whose session's `send` is a scripted mock.

1. [unit] `host.send("read https://b.example/doc", onEvent)` leaves `handle.web.exposure.hasSeen("https://b.example/doc")` true when the session's `send` is first called.
2. [unit] `host.send("[nax-tasks] background command bash-1 (curl https://evil.example/x) ended", onEvent, { automatic: true })` leaves `hasSeen("https://evil.example/x")` false after the turn.
3. [unit] `host.send` of a mention message attaching a file whose body holds `https://c.example/x` leaves `seenUrls` empty after the turn.
4. [unit] `handle.session.send("read https://d.example/y")` called directly leaves `hasSeen("https://d.example/y")` false.
5. [unit] `host.steer("see https://e.example/z")`, answered `accepted` by the session, leaves `hasSeen("https://e.example/z")` true.
6. [unit] `host.steer("see https://f.example/z", { automatic: true })`, answered `accepted`, leaves `hasSeen("https://f.example/z")` false.
7. [integration] In a mounted `ChatApp` with no turn running, a background task that ends delivers its notice through `host.send` with options exactly `{ automatic: true }`.
8. [integration] In a mounted `ChatApp` with a turn running, a background task that ends steers its notice through `host.steer(notice, { automatic: true })`.
9. [integration] (control) In a mounted `ChatApp`, a typed message `hello` reaches `host.send` with no `automatic` option.
10. [unit] `host.steer("see https://g.example/z")`, answered `unsupported`, leaves `hasSeen("https://g.example/z")` false.

### US-006

1. [unit] `createKodaMemoryProvider(...).effectiveWriteMode()` over a client answering `{ data: { mode: "proposal" } }` resolves `"proposal"`.
2. [unit] Two `effectiveWriteMode()` calls send two `GET projects/<project>/memory/write-mode` requests.
3. [unit] `effectiveWriteMode()` over a client answering `{ data: { mode: "weird" } }` rejects with `NaxError` code `MEMORY_KODA_BAD_RESPONSE`.
4. [unit] `createHostCompaction` with local `writeMode: "direct"` and a provider whose `effectiveWriteMode` resolves `"proposal"` rejects `applyCompaction` with `MEMORY_COMPACT_UNSUPPORTED`.
5. [unit] In that case `operations.applyMemoryCompaction` is never called.
6. [unit] With the same provider, `undoCompaction` rejects with `MEMORY_COMPACT_UNSUPPORTED` and `operations.undoMemoryCompaction` is never called.
7. [unit] With a provider whose `effectiveWriteMode` rejects with an error, `applyCompaction` rejects with that same error and `operations.applyMemoryCompaction` is never called.
8. [unit] (control) With a provider that has no `effectiveWriteMode` (the local provider) and local `writeMode: "direct"`, `applyCompaction` calls `operations.applyMemoryCompaction` with `provider` equal to that provider's `id`.
9. [integration] `createMemoryHost` configured for `memory.provider: "koda"`, with a Koda client stub answering `mode: "proposal"` on the write-mode route, rejects the host's `applyCompaction` with `MEMORY_COMPACT_UNSUPPORTED`.

### US-007

1. [integration] In a real repository, a `_ledgerCarryDeps.runGit` wrapper stages a different ledger version with `git add` just before `commitInPlaceAppend`'s `update-ref` runs. Afterwards that staged blob is still the ledger's index entry, as reported by `git ls-files -s`.
2. [integration] In that case `commitInPlaceAppend` returns `true`, and HEAD's ledger equals the appended text.
3. [integration] (control) With no concurrent staging, after `commitInPlaceAppend` the index entry for the ledger equals HEAD's blob.
4. [unit] `mergedLedgerText("a\nb\n", "a\nc\n")` returns `"a\nb\nc\n"`.
5. [unit] `mergedLedgerText("a\nb", "a\nc\n")` returns `"a\nb\nc\n"`.
6. [unit] `mergedLedgerText("a\nb\nc\n", "a\nc\n")` returns `null`.
7. [unit] (control) `mergedLedgerText("a\n", "a\nb\n")` returns `"a\nb\n"`.
8. [integration] With separate main and PR worktrees whose ledgers diverge (the PR holds a line main lacks), the bot ledger step commits a PR ledger holding the PR's lines followed by main's missing lines.
9. [integration] In that case the bot ledger step emits no "Main checkout ledger does not extend the PR's; not carried" warn.
10. [unit] `mergedLedgerText("old\n", "ol")` returns `null`.
11. [unit] `mergedLedgerText("a\nb", "a\nbc\n")` returns `"a\nb\nbc\n"`.
12. [unit] `mergedLedgerText("a\n", "a\nb\nc")` returns `"a\nb\n"`.
13. [integration] When `refreshIndexEntry`'s index read fails, `commitInPlaceAppend` still returns `true` and warns `Advisor ledger committed; the staged ledger differs and was left as is`.
14. [unit] `mergedLedgerText("a\nb", "a\nb\n")` returns `null`.
15. [unit] `mergedLedgerText("z\n", "x\nx\n")` returns `"z\nx\n"`.
