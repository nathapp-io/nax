# SPEC: review e684f920 fixes: shared transcript eviction and job panel log tail

## Summary

Two fixes from the verified code review of `e684f9205` (findings 2 and 13):

1. **A failed resume no longer evicts other sessions (finding 2).** The file transcript store's `retainFailed` prunes only kept-on-failure archives (`<name>.transcript.failed-<stamp>.json`), never live documents. The feature-startup sweep keeps pruning live names, as its contract requires. One chat's failed ACP resume then leaves every other chat's backend document, and its image sidecar, resumable.
2. **The job panel reads a bounded tail and shows the last non-empty lines (finding 13).** `ChatJobs.logTail` reads the log backward in fixed-size chunks instead of reading the whole file, and gains a `nonEmpty` option the job panel uses, so trailing blank lines no longer hide the last informative lines.

## Motivation

The review (`review-e684f920/REVIEW.md`) confirmed both defects at `e684f9205`:

- **Finding 2.** `createFileTranscriptStore(dir).retainFailed` renames the live document and then calls `pruneRetainedTranscripts(dir)`, which counts every name containing `.transcript.` and ending `.json` — live documents included — and deletes the oldest over `MAX_RETAINED_TRANSCRIPTS` (50). `openAcpBrain` (`packages/nax/src/chat/open-chat-session.ts`) builds one store per agent over `<sessions>/acp-<agent>`, a directory every chat on that agent shares, and calls `retainFailed` when a resume fails with an unusable-session error. With 51 live documents and no archives, one failed resume deleted an older chat's document; that chat's next open found `null` and silently created a fresh backend session. The ACP server (`packages/nax-agent-acp/src/server/main.ts`) shares one file store across all its sessions the same way. Pruning live names belongs to `sweepFeatureTranscripts` at feature startup (`.nax/features/dispatch-accounting-integrity/spec.md`, US-002), not to a failure path.
- **Finding 13.** `DetachedJobs.logTail` (`packages/nax/src/chat/jobs/job-runner.ts`) reads the whole log with `Bun.file(path).text()` and slices the last N raw lines; `readJobPanelView` asks for `JOB_PANEL_LOG_LINES` (12) and `logLinesOf` then drops empty lines. Two panel reads of a 16 MiB log each read 16 MiB to show 12 lines, and the use-job-panels timer refreshes a running paneled job every `JOB_PANEL_REFRESH_MS` (2000 ms). A log ending in 12 informative lines followed by 12 blank lines showed none, although the panel contract calls for the last 12 non-empty lines.

## Design

### Integration

Symbols this feature only reads:

- `packages/nax-agent/src/native/session/transcript-store.ts`: `retainTranscript(dir, sessionName)` (renames `<name>.transcript.json` to `<name>.transcript.failed-<stamp>.json` and moves the `.images` sidecar with it), `deleteTranscriptFile(path)`, `MAX_RETAINED_TRANSCRIPTS`.
- `packages/nax/src/session/transcript-sweep.ts`: `sweepFeatureTranscripts`, which calls `pruneRetainedTranscripts` without options and must keep pruning live names.
- `packages/nax/src/chat/open-chat-session.ts`: `openAcpBrain` — `store.load`, `deps.resumeAgentSession`, `isFreshFallback`, `store.retainFailed`, `deps.createAgentSession`. Unchanged.
- `packages/nax/src/chat/jobs/job-panel-view.ts`: `logLinesOf(logTail)` (trims, drops empty lines, keeps the last `JOB_PANEL_LOG_LINES`). Unchanged.
- `packages/nax/src/chat/background/task-registry.ts`: `readLogTail(path)`, a byte-bounded tail read with a newline-boundary rule, as a pattern; it is not reused because it bounds bytes, not lines.

Symbols this feature changes. Each **Baseline** exists only to locate the code. Implement the **Target**, never the baseline.

- `pruneRetainedTranscripts` (`packages/nax-agent/src/native/session/transcript-store.ts`).
  - Baseline: `pruneRetainedTranscripts(dir, maxRetained = MAX_RETAINED_TRANSCRIPTS): Promise<number>` counts and deletes live and archived names alike.
  - Target: `pruneRetainedTranscripts(dir, maxRetained = MAX_RETAINED_TRANSCRIPTS, opts?: { readonly archivesOnly?: boolean }): Promise<number>`. With `archivesOnly: true` only names containing `.transcript.failed-` and ending `.json` are counted and deleted; live documents are never touched. Without the option the behaviour is unchanged.
- `createFileTranscriptStore(dir).retainFailed` (same file).
  - Baseline: `retainTranscript(dir, id)` then `pruneRetainedTranscripts(dir)`.
  - Target: `retainTranscript(dir, id)` then `pruneRetainedTranscripts(dir, MAX_RETAINED_TRANSCRIPTS, { archivesOnly: true })`. The doc comments that describe the old prune (`transcript-store.ts` above `createFileTranscriptStore` and above `pruneRetainedTranscripts`, and `closeNativeSession` in `packages/nax-agent/src/native/session/session.ts`) are updated to say `retainFailed` bounds only the kept-on-failure archives and live names are bounded by the feature-startup sweep.
- `ChatJobs.logTail` and `DetachedJobs.logTail` (`packages/nax/src/chat/jobs/job-runner.ts`).
  - Baseline: `logTail(id: string, lines?: number): Promise<string>`; reads the whole file through `_jobRunnerDeps.readLog(path)`.
  - Target: `logTail(id: string, lines?: number, opts?: { readonly nonEmpty?: boolean }): Promise<string>`. It delegates to a new `readTailLines(path, lines, { nonEmpty })` in a new file `packages/nax/src/chat/jobs/log-tail.ts`. The raw-line result is unchanged for callers without the option (`jobs-provider.ts`, `useChatPicker.ts`): the last N lines, a single trailing line break ignored, `\r\n` treated as a break, `""` for a non-finite `lines`, for `lines < 1` (after flooring a fractional value), for a missing file or for an unknown id. With `nonEmpty: true` the result is the last N lines whose trimmed text is non-empty, returned as their original text (a trailing `\r` stripped, no other trimming), joined with `\n`. `readTailLines` returns `""` when `size` or `readRange` reports `ENOENT`; `Bun.file(path).size` of a missing file (0) also yields `""`. `_jobRunnerDeps.readLog` is replaced by `_logTailDeps` in `log-tail.ts`: `size(path): Promise<number>` and `readRange(path, start, end): Promise<Uint8Array>`, the seam tests count bytes through.
- `readTailLines` (new, `packages/nax/src/chat/jobs/log-tail.ts`). Reads backward from the end of the file in chunks of `LOG_TAIL_CHUNK_BYTES` (64 KiB), splitting on a local `NEWLINE_BYTE` constant (10) before decoding (so a multi-byte UTF-8 character is never cut), and stops as soon as it holds N qualifying lines plus one line break before them, or reaches the start of the file. Worked skeleton:

  ```ts
  export const LOG_TAIL_CHUNK_BYTES = 64 * 1024;
  export async function readTailLines(path: string, lines: number, opts: { readonly nonEmpty?: boolean } = {}): Promise<string> {
    // size = await _logTailDeps.size(path); end = size; carry = empty bytes
    // while end > 0 and collected < lines:
    //   start = max(0, end - LOG_TAIL_CHUNK_BYTES); chunk = await _logTailDeps.readRange(path, start, end)
    //   bytes = chunk + carry; split at NEWLINE_BYTE; the first piece becomes the new carry unless start === 0
    //   decode the complete pieces, strip a trailing "\r", walk them last-to-first, keep the ones that qualify
    //   end = start
    // return the kept lines in file order joined with "\n"
  }
  ```

- `logTailSource` (`packages/nax/src/chat/jobs/job-panel-view.ts`).
  - Baseline: `jobs.logTail(job.id, JOB_PANEL_LOG_LINES)`.
  - Target: `jobs.logTail(job.id, JOB_PANEL_LOG_LINES, { nonEmpty: true })`. The `Pick<ChatJobs, "logTail">` parameter type follows the new signature.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| The log file is missing when `logTail` runs | `""`, as today. |
| `readRange` or `size` throws any other error | The error propagates, as `readLog` errors do today; `logTailSource` turns it into `""` for the panel. |
| Pruning finds fewer archives than the cap | Nothing is deleted; returns 0. |

## Out of Scope

- Findings 1, 3-12 of review e684f920 belong to the other three review-e684 features (acp-sessions, workflow-verification, pi-client).
- Revising `.nax/features/chat-job-panel/spec.md` so its `readJobPanelView` paragraph names the `nonEmpty` read is a manual edit made with this spec; no story edits `.nax/`.
- `sweepFeatureTranscripts` keeps pruning live and archived names together at feature startup; its contract is unchanged.
- Archives already pruned by an earlier `retainFailed` are not recovered, and live documents deleted by an earlier failed resume are not recreated.
- US-003 only: the background-task log reader `readLogTail` in `task-registry.ts` keeps its byte-bounded behaviour.
- US-003 only: a `nonEmpty` read of a log that holds fewer qualifying lines than asked scans back to the start of the file; no byte cap is added for that case.
- US-003 only: the panel refresh cadence (`JOB_PANEL_REFRESH_MS`) is unchanged.
- US-003 only: a log line longer than the whole file's remaining bytes is returned whole, however long; no per-line length cap is added.

## Stories

**US-001: retainFailed prunes only kept-on-failure archives (finding 2, store).** Workdir: `packages/nax-agent`. No dependencies. `pruneRetainedTranscripts` gains `archivesOnly`; the file store's `retainFailed` passes it.

**US-002: a failed ACP chat resume leaves other chats resumable (finding 2, regression).** Workdir: `packages/nax`. Depends on US-001. Adds an `openChatSession` regression over a real file store showing that an older chat's backend document and image sidecar survive another chat's failed resume. No production code in `packages/nax` changes.

**US-003: the job panel reads a bounded tail of non-empty lines (finding 13).** Workdir: `packages/nax`. No dependencies. Adds `readTailLines` in `log-tail.ts`; `logTail` uses it and gains `nonEmpty`; `logTailSource` passes `{ nonEmpty: true }`.

### Context Files

**US-001**
- `packages/nax-agent/src/native/session/transcript-store.ts` — `createFileTranscriptStore`, `retainTranscript`, `pruneRetainedTranscripts`
- `packages/nax-agent/test/unit/native/transcript-store.test.ts` — `saveTranscript` / `retainTranscript` / `utimes` fixtures and the existing prune tests

**US-002**
- `packages/nax/src/chat/open-chat-session.ts` — `openAcpBrain`, `_openChatSessionDeps`
- `packages/nax/src/chat/acp/acp-session-options.ts` — `acpTranscriptDir`, `isFreshFallback`
- `packages/nax/test/unit/chat/open-chat-session-acp.test.ts` — the `resumeFailing(agentError("AGENT_SESSION_NOT_FOUND"))` fallback fixture, `_acpSessionDeps.acpBackend` stub and `open()` helper
- `packages/nax/test/unit/chat/open-chat-session-acp-zero-turn.test.ts` — the real-file-store precedent for `openChatSession`

**US-003**
- `packages/nax/src/chat/jobs/job-runner.ts` — `ChatJobs`, `DetachedJobs.logTail`, `_jobRunnerDeps`, `JOB_LOG_TAIL_LINES`
- `packages/nax/src/chat/jobs/job-panel-view.ts` — `logTailSource`, `logLinesOf`, `JOB_PANEL_LOG_LINES`
- `packages/nax/src/chat/background/task-registry.ts` — `readLogTail`, the newline-boundary pattern
- `packages/nax/test/unit/chat/jobs/job-runner-attach.test.ts` — the AC-17..19 `logTail` fixtures

### Creates

**US-001**
- `packages/nax-agent/test/unit/native/transcript-store-archives-only.test.ts` — archives-only prune tests, kept apart so `transcript-store.test.ts` (559 lines) stays under the 650-line split threshold

**US-002**
- `packages/nax/test/unit/chat/open-chat-session-acp-shared-store.test.ts` — the real-file-store failed-resume regression

**US-003**
- `packages/nax/src/chat/jobs/log-tail.ts` — `readTailLines`, `LOG_TAIL_CHUNK_BYTES`, `_logTailDeps`
- `packages/nax/test/unit/chat/jobs/log-tail.test.ts` — `readTailLines` tests (US-003 ACs 1-5)
- `packages/nax/test/unit/chat/jobs/job-runner-log-tail.test.ts` — `logTail` tests over a real `createJobRunner` with an attached job record and a temp `logPath`, as `job-runner-attach.test.ts` builds them (US-003 ACs 6-11 and 13)

### Modifies

**US-001**

None. Existing prune tests call `pruneRetainedTranscripts` without the option, whose behaviour is unchanged, and the existing `retainFailed` tests hold a single document.

**US-002**

None. The story adds a test file only.

**US-003**
- `packages/nax/test/unit/chat/jobs/job-panel-view.test.ts` — the assertion that `logTail` was called with exactly `("run-1a2b3c4d", JOB_PANEL_LOG_LINES)` now sees a third argument. The invariant becomes: called with `"run-1a2b3c4d"`, `JOB_PANEL_LOG_LINES` and `{ nonEmpty: true }`.

### Seams

- US-001 changes the behaviour of the exported `createFileTranscriptStore(...).retainFailed`; US-002 reaches it through `openChatSession`, the production entry point, with the real `createFileTranscriptStore` in `_openChatSessionDeps`, so a store that still prunes live names fails US-002's ACs.
- US-003's `readTailLines` is consumed by `DetachedJobs.logTail` in the same story; its ACs drive it through `logTail` and `readJobPanelView`.

## Acceptance Criteria

ACs marked **(control)** already pass on the baseline code and pin behaviour that must not regress; every other AC fails on the baseline.

### US-001

Setup for ACs 1-5: mtimes are set explicitly with `utimes`, as `transcript-store.test.ts` does. In ACs 4-5 the 50 archives get distinct mtimes, the other live document is older than every archive, and the document being retained is newer than every archive.

1. [unit] In a directory holding 51 live documents saved with `saveTranscript` (oldest mtime on `s-01`), `createFileTranscriptStore(dir).retainFailed("s-51")` leaves `load("s-01")` returning a non-null document.
2. [unit] In that case all 50 remaining live `<name>.transcript.json` files still exist, and exactly one `s-51.transcript.failed-<stamp>.json` exists.
3. [unit] In that case a `.transcript.images` sidecar saved for `s-01` still exists.
4. [unit] (control) In a directory holding 50 archives made with `retainTranscript` and 2 live documents, `retainFailed` of one live document leaves exactly 50 archives, deleting the oldest archive by mtime.
5. [unit] In that case the other live document is still loadable.
6. [unit] `pruneRetainedTranscripts(dir, 1, { archivesOnly: true })` over 2 live documents and 2 archives returns 1 and leaves both live documents.
7. [unit] (control) `pruneRetainedTranscripts(dir, 2)` without options over 3 live documents deletes the oldest live document and returns 1.
8. [unit] (control) `pruneRetainedTranscripts(dir, 1, { archivesOnly: true })` on a directory that does not exist returns 0.
9. [unit] `pruneRetainedTranscripts(dir, 5, { archivesOnly: true })` over 3 archives and 10 live documents returns 0 and deletes nothing.

### US-002

Setup: `openChatSession` with `_openChatSessionDeps.createFileTranscriptStore` left as the real `createFileTranscriptStore`, `_acpSessionDeps.acpBackend` stubbed as in `open-chat-session-acp.test.ts`, `createAgentSession` stubbed to return a fake session, and `resumeAgentSession` stubbed keyed on the session id: it rejects with a `NaxError` coded `AGENT_SESSION_NOT_FOUND` for `Y` and resolves a fake session for `X`. Chats `X` and `Y` each have their own `storage.writeMeta` record with an `acp:codex` model. The directory `acpTranscriptDir(storage.dir, "codex")` holds 51 live documents, including `X` and `Y`, each with an ended turn marker; mtimes are set with `utimes` so `X`'s document is the oldest, and `X` also has a `.transcript.images` sidecar. Chat `Y` is opened with `resumeId` `Y`.

1. [integration] After `Y`'s open resolves, `createFileTranscriptStore(dir).load("X")` returns a document with a turn marker.
2. [integration] In that case `X`'s `.transcript.images` sidecar still exists.
3. [integration] After `Y`'s open resolves and the `resumeAgentSession` and `createAgentSession` mock call counts are noted, a later `openChatSession` for `X` with `resumeId` `X` calls `resumeAgentSession` with session id `X` and leaves the `createAgentSession` call count unchanged (only `Y`'s call).
4. [integration] (control) In that case `Y`'s open called `createAgentSession` once and its handle carries `ACP_FRESH_SESSION_NOTICE("Codex")`.

### US-003

1. [unit] `readTailLines(path, 12, { nonEmpty: true })` on a log of 12 informative lines followed by 12 blank lines returns those 12 informative lines joined with `\n`.
2. [unit] On a 16 MiB log ending in 12 short lines, `readTailLines(path, 12)` returns exactly those 12 lines and reads at most `2 * LOG_TAIL_CHUNK_BYTES` bytes through `_logTailDeps.readRange`.
3. [unit] On a log sized so that offset `size - LOG_TAIL_CHUNK_BYTES` falls inside one of its last 3 lines, `readTailLines(path, 3)` returns those 3 lines intact.
4. [unit] On a log sized so that offset `size - LOG_TAIL_CHUNK_BYTES` falls inside a multi-byte UTF-8 character of its last line, `readTailLines(path, 1)` returns that line with the character intact.
5. [unit] `readTailLines(path, 2)` on `a\r\nb\r\nc\r\n` returns `b\nc`.
6. [unit] (control) `logTail(id, 2)` of a job runner whose job log is `a\nb\nc\n` returns `b\nc`.
7. [unit] (control) `logTail(id)` of a job runner whose job log has 50 lines returns the last `JOB_LOG_TAIL_LINES` (40) lines.
8. [unit] (control) `logTail(id, 2)` of a job runner whose job log is `a\n\n\n` returns `\n` (two blank lines).
9. [unit] (control) `logTail(id, 0)` and `logTail(id, Number.POSITIVE_INFINITY)` of a job runner return `""`, and `logTail` of a job whose log file is missing returns `""`.
10. [unit] `logTail(id, 2, { nonEmpty: true })` of a job runner whose job log is `a\n  \nb\n\n\n` returns `a\nb`.
11. [integration] `readJobPanelView` given a running job and a real `createJobRunner` (passed as its `jobs`) whose job log ends in 12 informative lines followed by 12 blank lines returns a view whose `logTail` holds those 12 lines.
12. [integration] `readJobPanelView` with a stubbed `jobs.logTail` calls it with the job id, `JOB_PANEL_LOG_LINES` and `{ nonEmpty: true }` (satisfied by the updated assertion in `job-panel-view.test.ts`).
13. [unit] `logTail(id)` of a job runner whose `_logTailDeps.readRange` rejects with an `EACCES` error rejects with that error, and `readJobPanelView` over that runner returns a view whose `logTail` is empty.
