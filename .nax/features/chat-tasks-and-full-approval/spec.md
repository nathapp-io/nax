# SPEC: chat jobs picker and full-mode job approval

Closes: #2747, #2748

## Summary

Two native-chat fixes found while driving a PR to ready from `nax chat`. First (#2748), in **full** mode the nax-jobs launch and control tools (`plan`, `run`, `bot_review`, `bot_fix`, `chain`, `cancel`) are approved without a card, exactly like every other tool in full mode; guarded mode keeps the card. Second (#2747), background work becomes visible and controllable from the TUI: the footer strip shows running background Bash tasks beside nax jobs, and a new **jobs picker** (the same pop-up list `/model` and `/resume` use) lists nax jobs and Bash tasks, prints a selected row's status and last 40 output lines into the transcript on Enter, and stops a running task or cancels a running job on ctrl+x. The picker opens from `/jobs`, from ctrl+g, and from a left click on the footer strip.

## Motivation

- #2748: `ChatAskController` already auto-allows tool approvals in full mode (`packages/nax/src/chat/ask-controller.ts`, the `this.mode === "full"` branch of the approval path), but nax-jobs cards go through `requestHostApproval`, which never checks the mode. `createHostJobs` (`packages/nax/src/chat/jobs/jobs-host.ts`) wires its `approve` straight to `options.asks.requestHostApproval(card)`, so `jobs-launch.ts` (launch), `chain-tools.ts` (chain) and `jobs-provider.ts` (cancel) always show a card and deny on the 10-minute timeout. A full-mode user driving `nax bot review` / `nax bot fix` from chat is stopped on every launch. The user ruled (2026-10-30) that full mode skips every nax-jobs host card; this reverses the earlier slice-2 rule that launches always ask.
- #2747: while the agent runs long work the transcript only says that something is running. The footer strip (`formatJobStrip` in `packages/nax/src/tui/chat/chat-status.ts`) lists nax jobs only; background Bash tasks (ctrl+b, `nax-tasks`) appear only in the `/jobs` text listing. The strip is plain text: no click, no key, no output view, no stop.

## Design

### Integration

Symbols this feature only **reads** (verified on main `199df884f`):

- `ChatBackgroundTasks` (`packages/nax/src/chat/background/task-types.ts`): `list(): readonly BackgroundTask[]` (newest first), `get(id)`, `running()`, `stop(id): BackgroundTask` (throws `NaxError` `CHAT_TASK_NOT_RUNNING` when the task is not running), `output(id, lines?): Promise<string>` (throws `CHAT_TASK_READ_FAILED` on a read error other than ENOENT), `onChange(listener)`.
- `BackgroundTask`: `{ id, command, description?, origin, startedAt, endedAt?, state: "running" | "succeeded" | "failed" | "stopped", exitCode?, note?, logPath }`.
- `ChatJobs` (`packages/nax/src/chat/jobs/job-runner.ts`): `list()` (newest first), `get(id)`, `running()`, `canCancel(id): Promise<{ ok: true } | { ok: false; message: string }>`, `cancel(id): Promise<ChatJob>`, `logTail(id, lines?): Promise<string>`, `onChange(listener)`.
- `ChatJob` (`packages/nax/src/chat/jobs/job-types.ts`): `{ id, kind: "plan" | "run" | "bot_review" | "bot_fix", target, state: "running" | "succeeded" | "failed" | "cancelled" | "lost", startedAt, progress?, cost?, ... }`.
- `ChatHost` (`packages/nax/src/chat/chat-host.ts`): `readonly jobs?: ChatJobs`, `readonly tasks?: ChatBackgroundTasks`, `current(): ChatHostState` (throws `CHAT_SESSION_NOT_OPEN` without a session).
- `ChatAskController.requestHostApproval(card: HostApprovalCard): Promise<"allow" | "deny">` and `HostApprovalCard { tool, summary, command?, reason, signal? }` (`packages/nax/src/chat/ask-controller.ts`). Unchanged by this feature: it stays the primitive that always shows a card.
- `relativeTime(iso, nowMs)` (`packages/nax/src/tui/chat/relative-time.ts`), `displayWidth(text)` (`packages/nax/src/tui/chat/styled-line.tsx`), `spansWidth(spans)` (`packages/nax/src/tui/chat/wrap.ts`).
- `MouseEvents.subscribe(listener)` and `MouseEvent { kind, button, x, y }` (1-based columns and rows) (`packages/nax/src/tui/chat/mouse-input.ts`).
- The transcript `listing` entry `{ kind: "listing"; title: string; text: string }` (`packages/nax/src/tui/chat/transcript-model.ts`), which keeps line breaks in `text` (a `notice` flattens them to one row).
- `FRAME_SLACK_ROWS = 1` in `ChatApp.tsx`: the frame is `size.rows - FRAME_SLACK_ROWS` rows tall and the footer is its last row, so the footer's 1-based terminal row is `size.rows - FRAME_SLACK_ROWS`.

Symbols this feature **changes**. Each baseline exists only to locate the code; it is never the interface to implement.

- `createHostJobs` options (`jobs-host.ts`).
  Baseline: `HostJobsOptions { repoRoot, outputDir, naxEntry, config, asks, sessionId, now, logger }`; `approve = (card) => options.asks.requestHostApproval(card)`.
  Target: `HostJobsOptions` gains required `readonly mode: () => ChatMode`. `approve(card)` reads `options.mode()` at call time: when it returns `"full"`, it resolves `"allow"` without calling `requestHostApproval` (or `"deny"` when `card.signal` is already aborted); otherwise it calls `options.asks.requestHostApproval(card)` as today.
- `ChatHost` constructor's `createHostJobs({...})` call (`chat-host.ts`).
  Target: passes `mode: () => (this.handle?.meta.mode === "full" ? "full" : "guarded")`. Without an open session the getter returns `"guarded"`, so the card is shown (fail closed).
- `formatJobStrip` / `footerModel` (`chat-status.ts`).
  Baseline: `formatJobStrip(jobs: readonly FooterJob[]): string`; `footerModel(input: { state, status, hint, copiedChars?, glyphs?, jobs? }): { left; right }`.
  Target: `formatJobStrip(jobs: readonly FooterJob[], tasks: readonly FooterTask[] = []): string`, with exported `interface FooterTask { readonly command: string }`; `footerModel` input gains `tasks?: readonly FooterTask[]`; its result gains `stripWidth: number`, the display width of the strip text (0 when no strip is drawn). Jobs come first, then tasks; at most `JOB_STRIP_LIMIT` (2) parts are shown and the rest are counted as ` +N`. A task part is `bash <command>`: the command reduced to one row, cut to `JOB_TARGET_LIMIT` (16) display columns, measured with `displayWidth` (`styled-line.tsx`) so a wide character counts two columns, with `…` in the last column when longer.
- `useJobs` (`packages/nax/src/tui/chat/use-jobs.ts`).
  Baseline: returns `{ running, backgroundable, noteUserTurn }`.
  Target: also returns `tasks: readonly BackgroundTask[]`, equal to `host.tasks?.running() ?? []`, refreshed by the existing `tasks.onChange` subscription.
- `PickerKind` (`packages/nax/src/tui/chat/slash-commands.ts`).
  Baseline: `"model" | "resume" | "mode" | "effort"`.
  Target: `"model" | "resume" | "mode" | "effort" | "jobs"`.
- `pickerModel` / `PickerModelInput` (`packages/nax/src/tui/chat/picker-model.ts`).
  Target: `PickerModelInput` gains `jobs?: readonly ChatJob[]` and `tasks?: readonly BackgroundTask[]`; `pickerModel({ kind: "jobs", ... })` returns the jobs rows described under Approach.
- `Picker` props and pointer (`packages/nax/src/tui/chat/Picker.tsx`).
  Baseline: the pointer is an index (`PickerSelection.index`, held in `selection` and the `latest` ref), reset only when `kind` or `query` changes; `ownsPickerKey` owns no ctrl chord, and the `key.shift || key.ctrl || key.meta` early return drops every chord before `applyEntryKey`.
  Target: gains optional `onStop?: (entry: PickerEntry) => void`. For `model.kind === "jobs"`: `ownsPickerKey` owns ctrl+x, which is handled before the chord early return and calls `onStop` with the highlighted entry; and the pointer stores the highlighted entry's `value` (in `latest` too, so batched keys see it), deriving the index from `model.entries` on each render and falling back to index 0 only when that value is no longer listed. Other kinds keep the index pointer.
- `useChatPicker` (`packages/nax/src/tui/chat/useChatPicker.ts`).
  Target: `ChatPickerOptions` gains `show(entry: TranscriptEntry): void`; `ChatPicker` gains `stop(entry: PickerEntry): void`; `choose` for the jobs kind shows output instead of calling a host action; `modelOf` passes `host.jobs?.list()` and `host.tasks?.list()` read at render time.
- `runSlashCommand` `jobs` case (`slash-commands.ts`).
  Baseline: shows `formatSessionJobs(host)` text.
  Target: returns `{ kind: "picker", picker: "jobs" }` when `host.jobs` or `host.tasks` is present, ignoring any arguments (`/jobs foo` opens the same picker); otherwise shows `jobs are not available in this session` as today. `COMMAND_DESCRIPTIONS.jobs` becomes `Show nax jobs and background tasks`.
- `slashSink` / `SlashSink` (file-local in `ChatApp.tsx`).
  Target: moved unchanged to new `packages/nax/src/tui/chat/slash-sink.ts` and exported, so `ChatApp.tsx` (599 of its 600-line cap) has room for this feature's wiring.

### Approach

**Jobs picker rows** (`pickerModel` for kind `jobs`):

- Title: `Jobs and tasks · enter output · ctrl+x stop`.
- Rows: every job from `jobs` and every task from `tasks`. Running rows first, then the rest; within each group newest `startedAt` first, and rows with equal `startedAt` ordered by `value` ascending. At most 20 rows (`MAX_JOB_PICKER_ROWS`).
- Job row: `value` = job id; `label` = `<kind> <target>`, with `#` before the target for `bot_review` / `bot_fix`; `detail` = `<state> · <relativeTime(startedAt, now)>` (the time part and its separator are omitted when `relativeTime` returns an empty string), then ` · <passed>/<total>` when `progress` is present, then ` · $<cost to 2 decimals>` when `cost` is present.
- Task row: `value` = task id; `label` = `bash <command>` (one row); `detail` = `<state> · <relativeTime(startedAt, now)>`.
- No row is marked `current`. No query filtering (typing does nothing, as in the mode picker).
- Note row: the picker's warning (`PickerState.warning`) when one is set, shown with tone `warning`; otherwise `no jobs or tasks` (muted) when there are no rows; otherwise none. A successful stop clears the warning.

**Highlight.** The jobs list is live and regroups as rows change state, so the jobs picker keeps its highlight by the highlighted entry's `value`, not by its index (owned by `Picker`, see Integration): after a re-render the same row stays highlighted wherever it moved (falling back to the first row only when that row is gone). Other picker kinds keep their index highlight.

**No host control.** Enter and ctrl+x in the jobs picker do not go through `runControl`: they act on jobs and tasks, not on the session, so they work while a turn is running. An open picker still holds back job and task notices (`bottomBlocked`), as every picker does today.

**Enter on a jobs row** (`useChatPicker.choose`): the picker closes. The row's id is looked up first in `host.tasks` (`get`), then in `host.jobs` (`get`). The output is read with `host.tasks.output(id, 40)` or `host.jobs.logTail(id, 40)`, then shown, through the `show` option `ChatApp` supplies (which appends the entry), as one `listing` entry whose title is `<label> · <state>` and whose text is the output, or `(no output yet)` when the output is empty. The listing is local to the TUI: it is never sent to the agent.

**ctrl+x on a jobs row** (`useChatPicker.stop`): the picker stays open. A running task is stopped with `host.tasks.stop(id)`. For a running job, `host.jobs.canCancel(id)` is checked first; on `ok` it calls `host.jobs.cancel(id)`, otherwise the picker shows the returned `message` as its warning row. A row that is not running shows `<id> is not running` as the warning row. No approval card is shown: the user chose the action themself. Rows reflect the new state on the next render, because the screen re-renders on `jobs.onChange` / `tasks.onChange` and the picker reads the lists at render time.

**Openers.** All three open the same picker through `picker.open("jobs")`. `/jobs` returns the `{ kind: "picker", picker: "jobs" }` slash outcome (US-005). A slash command typed during a turn only prints the busy notice, so during a turn the picker is opened with ctrl+g or the footer click. ctrl+g and the footer click are handled by one hook, `useJobsOpener({ host, mouse, blocked, footer, size, open, note })`, in new `packages/nax/src/tui/chat/use-jobs-opener.ts`, so `ChatApp` gains one call site (US-007); the hook derives the footer row as `size.rows - FRAME_SLACK_ROWS`, and `rightWidth` and `stripWidth` from `footer`. `FRAME_SLACK_ROWS` moves from `ChatApp.tsx` into `use-jobs-opener.ts` (exported), and `ChatApp.tsx` imports it from there, so no import cycle forms. `ChatApp` passes `blocked` as `bottomBlocked(ask, picker.model) || menuShown()`:

- ctrl+g (`JOBS_KEY = "g"`), only while no ask card, no picker and no slash menu is shown (`blocked` false). ctrl+j is not used: terminals send it as a line feed. When the host has neither jobs nor tasks, ctrl+g shows the notice `jobs are not available in this session`.
- A left-button press and release on the same cell of the footer strip, only while `blocked` is false. The hit test is the pure exported function `footerStripHit(input: { x: number; y: number; footerRow: number; columns: number; rightWidth: number; stripWidth: number }): boolean`. It is true when `stripWidth > 0`, `y === footerRow`, and `x` is from `columns - rightWidth + 1` to `columns - rightWidth + stripWidth` inclusive. The footer's right line is drawn flush right, so its first column is `columns - rightWidth + 1`. `rightWidth` is `spansWidth(footer.right)` and `stripWidth` is `footerModel(...).stripWidth`.

### Failure Handling

| Case | Behaviour |
|:-----|:----------|
| Full mode, card signal already aborted | `approve` resolves `"deny"` without a card |
| Enter on a row whose id neither `host.tasks.get` nor `host.jobs.get` knows any more | notice `<id> is no longer listed`; no listing |
| `tasks.output` / `jobs.logTail` rejects | the picker is already closed; the error goes to the picker's existing `onError` (`ChatApp`'s `showError`), which appends an `error` entry with the error's message |
| ctrl+x on a row that is not running | picker warning row `<id> is not running`; nothing is stopped |
| ctrl+x on a job whose `canCancel` returns `{ ok: false, message }` | picker warning row shows `message`; `cancel` is not called |
| `tasks.stop` throws (the task ended between render and key) or `jobs.cancel` rejects | picker warning row shows the error's message; the picker stays open |
| ctrl+g or footer click while an ask card, a picker or the slash menu is shown | ignored |
| ctrl+g with neither `host.jobs` nor `host.tasks` | notice `jobs are not available in this session` |

## Out of Scope

- An ACP brain's own background shells (Claude Code, Codex or Cursor running a command in the background inside the agent) are not shown: nax never sees them. Only host-owned Bash tasks (`nax-tasks`) and nax jobs are listed.
- A live, continuously tailing output panel is not built; Enter prints one snapshot of the last 40 lines.
- The jobs picker does not filter by typed text.
- ctrl+x in the jobs picker never shows a confirmation card, in either mode.
- Questions a running job asks (run asks routed to chat cards) still show in full mode; only nax-jobs host approval cards are skipped.
- `ChatAskController.requestHostApproval` keeps its current behaviour (always a card); the full-mode decision lives in `createHostJobs`'s `approve`.
- Background task records stay in memory only; nothing new is persisted across chats.
- The ACP `/model` picker showing agents' advertised models before first open (#2746) is a separate feature.
- The `check:file-sizes` baseline is not edited by any story.
- The close confirmation card (`nax-close`, raised through `asks` directly, not through `createHostJobs`) still shows in full mode.
- The agent-facing nax-jobs wording (`buildJobsInstructions` in `workflow-builder.ts`, tool descriptions in `jobs-provider.ts` saying a call shows or asks for an approval card) is kept as is; in full mode the card is simply not shown and the call proceeds.
- The footer click hit test assumes the footer's right line is drawn flush right; when the left and right lines together are wider than the terminal and the right line is clipped, a click may miss the strip.
- An output listing keeps the existing listing colouring (`listingTone` in `layout-listing.ts`), so log lines containing words such as `failed` may be coloured.
- With full mode, the agent can start a billed `chain` (and its `costCap`) without a human yes; this follows the user's ruling and is called out in the PR description, not changed in code.

## Stories

### US-001: Full mode approves nax-jobs cards without asking

No dependencies. Workdir: `packages/nax`.

`createHostJobs` takes a required `mode: () => ChatMode` option and its `approve` resolves `"allow"` without a card when the mode is full at call time (or `"deny"` when the card's signal is already aborted). In guarded mode it keeps calling `asks.requestHostApproval`. `ChatHost` passes a getter over the open session's meta mode (`"guarded"` without a session, kept as a code comment; no public path reaches the getter before `start`). This covers launch (`plan`, `run`, `bot_review`, `bot_fix`), `chain` and `cancel`, because all three go through the same `approve`.

### US-002: Move the slash sink out of ChatApp

No dependencies. Workdir: `packages/nax`.

Pure move, no behaviour change: `SlashSink` and `slashSink(title, append)` move from `ChatApp.tsx` to new `slash-sink.ts` and are exported from there. `ChatApp.tsx` imports them. This frees room under the 600-line source convention for US-003, US-005, US-006 and US-007. Verification note: `check:file-sizes` scans only `.ts` files, so the implementer confirms by line count that `ChatApp.tsx` stays under 600 lines.

### US-003: Footer strip shows background tasks

Depends on US-002. Workdir: `packages/nax`.

New tests go in a new file, because `chat-status.test.ts` is at 658 of 800 lines. `formatJobStrip` takes running tasks after jobs and draws each as `bash <command>`. `footerModel` takes `tasks` and returns `stripWidth`. `useJobs` returns the running tasks, and `ChatApp` passes them to `footerModel`.

### US-004: Jobs picker model

No dependencies. Workdir: `packages/nax`.

`PickerKind` gains `"jobs"`, and `pickerModel` builds the jobs rows, title and empty note described under Design § Approach from `PickerModelInput.jobs` and `.tasks`.

### US-005: Open the jobs picker with /jobs and show output

Depends on US-002, US-004. Workdir: `packages/nax`.

`/jobs` returns the jobs picker outcome when the host has jobs or tasks, ignoring arguments (otherwise the existing unavailable notice), and `COMMAND_DESCRIPTIONS.jobs` becomes `Show nax jobs and background tasks`. The file-local `formatSessionJobs` and its `formatJobsListing` / `formatTasksListing` imports in `slash-commands.ts` are deleted in this story so lint stays clean. `useChatPicker` reads `host.jobs?.list()` / `host.tasks?.list()` at render time for the jobs kind. Enter shows the row's output as a `listing` entry through the new `show` option, bypassing `runControl`. `ChatApp` passes `show` (appending the entry). All ACs run on a mounted `ChatApp` (the `mount` export of `test/helpers/chat-picker.tsx`), opening the picker with `/jobs`.

### US-006: Stop a job or task from the jobs picker

Depends on US-005. Workdir: `packages/nax`.

`Picker` owns ctrl+x for the jobs kind (handled before its chord early return), calls the new `onStop`, and keeps the jobs highlight by entry `value`. `useChatPicker` gains `stop(entry)`, which stops a running task or cancels a running job with the warnings in Failure Handling, bypassing `runControl`. `ChatApp` passes `onStop={picker.stop}`. All ACs run on a mounted `ChatApp`, opening the picker with `/jobs`.

### US-007: Open the jobs picker from ctrl+g and a footer click

Depends on US-003, US-006. Workdir: `packages/nax`.

New `use-jobs-opener.ts` exports `footerStripHit` and `useJobsOpener({ host, mouse, blocked, footer, size, open, note })`, which handles ctrl+g and footer-strip clicks. `ChatApp` calls it once.

### US-008: Remove the replaced /jobs text listing

Depends on US-007. Workdir: `packages/nax`.

Deletion only. Once `/jobs` opens the picker (US-005, which already deleted the file-local `formatSessionJobs`), `formatTasksListing` (`packages/nax/src/chat/background/tasks-listing.ts`, plus its `background/index.ts` export) and `formatJobsListing` (`packages/nax/src/chat/jobs/jobs-listing.ts`, plus its exports in `chat/jobs/index.ts` and `chat/index.ts`) have no production caller. Delete them and their unit tests `test/unit/chat/background/tasks-listing.test.ts` and `test/unit/chat/jobs/jobs-listing.test.ts`. Verification note: removal is checked by `bun run typecheck` and `bun run lint` (no remaining reference compiles), not by acceptance criteria.

### Context Files

**US-001**
- `packages/nax/src/chat/jobs/jobs-host.ts` — the `approve` wiring to change
- `packages/nax/src/chat/ask-controller.ts` — `requestHostApproval` and the full-mode branch it mirrors
- `packages/nax/src/chat/chat-host.ts` — the `createHostJobs` call site
- `packages/nax/test/unit/chat/chat-host-jobs.test.ts` — host fixture with nax-jobs tools
- `packages/nax/test/unit/chat/chat-host-chain.test.ts` — `createHostJobs` fixture and chain card tests

**US-002**
- `packages/nax/src/tui/chat/ChatApp.tsx` — current home of `slashSink`

**US-003**
- `packages/nax/src/tui/chat/chat-status.ts` — `formatJobStrip`, `footerModel`
- `packages/nax/src/tui/chat/use-jobs.ts` — running jobs and the tasks subscription
- `packages/nax/src/tui/chat/ChatApp.tsx` — the `footerModel` call
- `packages/nax/src/chat/background/task-types.ts` — `BackgroundTask`

**US-004**
- `packages/nax/src/tui/chat/picker-model.ts` — `pickerModel`, `TITLES`, `PickerEntry`
- `packages/nax/src/tui/chat/slash-commands.ts` — `PickerKind`
- `packages/nax/src/tui/chat/relative-time.ts` — `relativeTime`
- `packages/nax/src/chat/jobs/job-types.ts` — `ChatJob`
- `packages/nax/src/chat/background/task-types.ts` — `BackgroundTask`

**US-005**
- `packages/nax/src/tui/chat/slash-commands.ts` — the `jobs` case, `formatSessionJobs`, `COMMAND_DESCRIPTIONS`
- `packages/nax/src/tui/chat/useChatPicker.ts` — `choose`, `modelOf`, picker state
- `packages/nax/src/tui/chat/ChatApp.tsx` — `useChatPicker` and `<Picker>` call sites
- `packages/nax/src/chat/jobs/job-runner.ts` — `ChatJobs` (`logTail`)
- `packages/nax/test/helpers/chat-picker.tsx` — mounted `ChatApp` picker harness (`mount`)

**US-006**
- `packages/nax/src/tui/chat/Picker.tsx` — `ownsPickerKey`, `applyEntryKey`, the pointer, props
- `packages/nax/src/tui/chat/useChatPicker.ts` — picker state and `warning`
- `packages/nax/src/tui/chat/ChatApp.tsx` — the `<Picker>` call site
- `packages/nax/src/chat/jobs/job-runner.ts` — `ChatJobs` (`canCancel`, `cancel`)
- `packages/nax/src/chat/background/task-types.ts` — `ChatBackgroundTasks.stop`

**US-007**
- `packages/nax/src/tui/chat/ChatApp.tsx` — footer, `size`, `FRAME_SLACK_ROWS`, `picker.open`
- `packages/nax/src/tui/chat/mouse-input.ts` — `MouseEvents`, `MouseEvent`
- `packages/nax/src/tui/chat/use-mouse-selection.ts` — the existing click pattern (press then release on one cell)
- `packages/nax/test/ui/chat/mouse.ts` — fake mouse events for UI tests

**US-008**
- `packages/nax/src/chat/background/index.ts` — `formatTasksListing` re-export
- `packages/nax/src/chat/index.ts` — `formatJobsListing` re-export

### Creates

**US-002**
- `packages/nax/src/tui/chat/slash-sink.ts`
- `packages/nax/test/unit/tui/chat/slash-sink.test.ts`

**US-003**
- `packages/nax/test/unit/tui/chat/chat-status-tasks.test.ts`

**US-004**
- `packages/nax/test/unit/tui/chat/picker-model-jobs.test.ts`

**US-005**
- `packages/nax/test/ui/chat/jobs-picker.test.tsx`

**US-006**
- `packages/nax/test/ui/chat/jobs-picker-stop.test.tsx`

**US-007**
- `packages/nax/src/tui/chat/use-jobs-opener.ts`
- `packages/nax/test/unit/tui/chat/use-jobs-opener.test.ts`
- `packages/nax/test/ui/chat/jobs-opener.test.tsx`

### Modifies

**US-001**
- `packages/nax/test/unit/chat/chat-host-jobs.test.ts` — the test "AC-9/10/11 full mode launch waits on a real expiring host card and deny declines" pins the old rule that a full-mode launch shows a card. Replace it: the expiring-card-and-deny assertions run with the host started in guarded mode, which needs no posture here because the fixture injects a mock `open`: make that mock return `meta.mode` `"ask"` or `"full"` from the request's mode instead of the hard-coded `"full"` (so `switchTo({ mode })` reopens), and a full-mode launch asserts that no card is pending and the job is spawned.
- `packages/nax/test/unit/chat/chat-host-chain.test.ts` — `compose()` calls `createHostJobs` without the new required `mode` option, and the test "AC-18 full mode keeps the chain card pending until explicitly resolved", the `approveChain` helper and the `parentHost` fixture rely on a full-mode chain card. Supply `mode` in `compose()` (`() => "guarded"` wherever a test expects the spied `requestHostApproval` to be called). Parametrise `parentHost` by mode (its mock `open` returning `meta.mode` from the request mode) and run `approveChain` and every card-expecting test in guarded mode. Replace AC-18 with: in full mode the chain tool activates without a pending card.

**US-002**
None. `slashSink` is file-local to `ChatApp.tsx` and no test imports it; UI tests reach it only through rendered output, which does not change.

**US-003**
None. `tasks` is an optional new input of `formatJobStrip` / `footerModel`, so the existing `chat-status.test.ts` calls and their `.left` / `.right` assertions keep their results.

**US-004**
None. `PickerKind` and `pickerModel` gain a member and a branch; existing kinds' rows are unchanged.

**US-005**
- `packages/nax/test/ui/chat/slash-commands.test.tsx` — the help listing assertion pins the line "/jobs  List nax jobs"; it becomes "/jobs  Show nax jobs and background tasks". The test "US-015 AC-1 AC-2 lists jobs locally without a model call" pins the /jobs text listing; replace it with: /jobs with a host that has jobs opens the jobs picker (title "Jobs and tasks · enter output · ctrl+x stop") without a model call. "US-015 AC-3 reports jobs unavailable" stays. Remove the test file's `formatJobsListing` import and use with it, since US-008 deletes that function.
- `packages/nax/test/ui/chat/task-notices.test.tsx` — "AC-16/17 /jobs lists tasks" pins the /jobs text row "bash-1a2b3c4d running bun dev"; replace it with: /jobs opens the jobs picker and the frame shows the task row (label "bash bun dev", detail starting "running"). "a rejected task notice stays queued without using a guard turn" submits /jobs only to force a re-render that retries notice delivery; an open picker now blocks delivery, so use a non-picker local command such as /mcp for the nudge. "AC-19" stays.
- `packages/nax/test/ui/chat/run-ask-notices.test.tsx` — a test submits /jobs only to force a re-render that retries run-ask notice delivery; an open picker now blocks delivery, so use a non-picker local command such as /mcp for the nudge.
- `packages/nax/test/ui/chat/picker.test.tsx` — the direct `useChatPicker` harness (the US-007 hook query state test) calls `useChatPicker({ host, runControl, onError })`; supply the new required `show` option (a no-op) and keep its model query, cancel and reopen assertions unchanged.

**US-006**
None. `onStop`, the jobs pointer and `stop` are new and apply only to the jobs kind; the existing pickers' keys and pointer behave as before, and US-005's tests do not press ctrl+x.

**US-007**
- `packages/nax/test/helpers/chat-picker.tsx` — `mount` renders `ChatApp` without a `mouse` prop; add an optional `mouse` mount option passed through to `ChatApp`, so the footer-click ACs can emit fake mouse events. Existing callers are unchanged.

**US-008**
- `packages/nax/test/unit/chat/background/tasks-listing.test.ts` — tests `formatTasksListing`, which this story deletes; delete the file.
- `packages/nax/test/unit/chat/jobs/jobs-listing.test.ts` — tests `formatJobsListing`, which this story deletes; delete the file.

### Seams

- US-003 -> US-007: `footerModel(...).stripWidth` feeds `footerStripHit` through `useJobsOpener`; the seam AC in US-007 drives a real `ChatApp` with a running task and clicks the strip.
- US-004 -> US-005: `pickerModel({ kind: "jobs", jobs, tasks })` rows are what `useChatPicker` draws; US-005's ACs open it with `/jobs` on a mounted `ChatApp`.
- US-005 -> US-006: `useChatPicker`'s jobs state and `show`/`onError` wiring carry the stop warnings; US-006's seam AC redraws the open picker after the registry's `onChange`.
- US-006 -> US-007: `picker.open("jobs")` is the picker every opener opens; US-005 and US-006 enter at `/jobs`, US-007 at ctrl+g and a mouse click, all on a mounted `ChatApp`.
- US-001: `ChatHost` passes `mode` into `createHostJobs`; the seam AC enters at the nax-jobs provider tool registered on the session open request.

## Acceptance Criteria

### US-001

Launch ACs (1, 2, 4, 5, 8, 9) use a feature with a pending story in `prd.json` and the `_jobsLaunchDeps.git` stub returning branch `feat/f1`, as the existing `chat-host-jobs.test.ts` launch test does.

1. [unit] `createHostJobs` with `mode: () => "full"`: running the nax-jobs `run` tool (which calls the composed `approve`) proceeds to start the job, and `asks.requestHostApproval` is never called.
2. [unit] `createHostJobs` with `mode: () => "guarded"`: running the nax-jobs `run` tool calls `asks.requestHostApproval` once with a card whose `tool` is `nax-jobs__run`.
3. [unit] With `mode: () => "full"`, a call whose card `signal` is already aborted resolves the decision `"deny"` (the tool returns `isError: true`) and `asks.requestHostApproval` is never called.
4. [unit] The mode is read at call time: with a getter that returns `"guarded"` on its first call and `"full"` on its second, the first launch calls `asks.requestHostApproval` and the second does not.
5. [integration] A `ChatHost` started in full mode: running the `run` tool from the `nax-jobs` provider on the session open request spawns the job (`_jobRunnerDeps.spawn` called once) and `host.asks.pending()` stays empty.
6. [integration] A `ChatHost` started in full mode: the `nax-jobs` `chain` tool activates its proposal with `host.asks.pending()` empty throughout.
7. [integration] A `ChatHost` started in full mode with a running owned job: the `nax-jobs` `cancel` tool sends the cancel (the job record gets `cancelRequested`) with `host.asks.pending()` empty.
8. [integration] A `ChatHost` started in guarded mode: running the `nax-jobs` `run` tool leaves exactly one pending ask whose `tool` is `nax-jobs__run`, and resolving it `deny` returns a tool result with `isError: true` whose content contains `declined`.
9. [integration] A `ChatHost` started in guarded mode and then switched with `host.switchTo({ mode: "full" })`: the next `nax-jobs` `run` call spawns without a pending ask.

### US-002

1. [unit] `slashSink(undefined, append)` imported from `slash-sink.ts`: each `show(text)` appends one `{ kind: "notice", text }` entry immediately.
2. [unit] `slashSink("Skills", append)`: two `show` calls append nothing until `flush()`, which appends one `{ kind: "listing", title: "Skills", text: "<first>\n<second>" }` entry.
3. [unit] `slashSink("Skills", append)` with no `show` call: `flush()` appends nothing.
4. [integration] On a mounted `ChatApp`, `/help` adds one listing titled `Commands` to the frame, and an unknown command `/nope` adds the notice `unknown command /nope`.

### US-003

1. [unit] `formatJobStrip([], [{ command: "bun run test" }])` returns `bash bun run test`.
2. [unit] `formatJobStrip([{ kind: "plan", target: "f1" }], [{ command: "ls" }])` returns `plan f1 · bash ls` (jobs before tasks).
3. [unit] `formatJobStrip` with two jobs and one task returns the two job parts followed by ` +1`.
4. [unit] A task command longer than 16 display columns is cut to 16 columns ending in `…` (`bash a-very-long-com…` for `a-very-long-command-line`).
5. [unit] A task command of nine two-column characters (18 display columns) is cut to 7 of them (14 columns) plus the 1-column `…`, never splitting a character.
6. [unit] A task command containing a line break is drawn on one row (the break becomes a space) before it is cut.
7. [unit] `footerModel` with `tasks: [{ command: "ls" }]` and no jobs returns `right[0].text === "bash ls"` and `stripWidth` equal to `displayWidth("bash ls")`.
8. [unit] `footerModel` with neither jobs nor tasks returns `stripWidth === 0` and the same `right` as a call without the `tasks` field.
9. [unit] `footerModel` with one job and no tasks returns `stripWidth` equal to the display width of the job part (`plan f1` -> 7).
10. [unit] `useJobs` over a host whose `tasks.running()` returns one task returns that task in `tasks`; after the task registry's `onChange` fires with `running()` now empty, the next render's `tasks` is empty.
11. [integration] A mounted `ChatApp` whose host has one running background task with command `sleep 60` and no jobs draws `bash sleep 60` on the footer row.

### US-004

1. [unit] `pickerModel({ kind: "jobs", jobs: [], tasks: [] })` returns title `Jobs and tasks · enter output · ctrl+x stop`, no entries, and note `{ text: "no jobs or tasks", tone: "muted" }`.
2. [unit] With no rows and a `warning` of `job is not owned by this chat`, the note is `{ text: "job is not owned by this chat", tone: "warning" }`.
3. [unit] A running task `bash-1a2b3c4d` with command `bun run test` yields an entry with `value: "bash-1a2b3c4d"`, `label: "bash bun run test"`, and `detail` starting with `running · `.
4. [unit] A `run` job `run-0000aaaa` on target `f1` with `progress { passed: 3, total: 7 }` and `cost 1.2` yields `label: "run f1"` and `detail` ending with ` · 3/7 · $1.20`.
5. [unit] A `bot_review` job on target `42` yields `label: "bot_review #42"`.
6. [unit] The detail's time part is `relativeTime(startedAt, nowMs)` for the input `nowMs`.
7. [unit] Running rows come before ended rows whatever their start times: a running task started earlier than an ended job is listed first.
8. [unit] Within the running group and within the ended group, rows are ordered by newest `startedAt` first, jobs and tasks interleaved.
9. [unit] Two rows with equal `startedAt` are ordered by `value` ascending.
10. [unit] With 25 rows' worth of jobs and tasks, `entries` has 20 rows (`MAX_JOB_PICKER_ROWS`).
11. [unit] No jobs entry carries `current: true`.
12. [unit] `pickerModel` for the existing `model`, `mode`, `effort` and `resume` kinds returns the same model as before when `jobs` and `tasks` are also supplied.

### US-005

All ACs run on a mounted `ChatApp` (the `mount` export of `test/helpers/chat-picker.tsx`) and open the picker by typing `/jobs`.

1. [integration] With a host that has jobs, `/jobs` opens the picker titled `Jobs and tasks · enter output · ctrl+x stop`.
2. [integration] Opening the picker with `/jobs` sends no turn to the session (`send` is not called).
3. [integration] `/jobs foo` opens the same jobs picker.
4. [integration] With a host that has neither `jobs` nor `tasks`, `/jobs` shows the notice `jobs are not available in this session` and opens no picker.
5. [integration] `/help` lists `/jobs  Show nax jobs and background tasks`.
6. [integration] Over a host whose `tasks.output("bash-1a2b3c4d", 40)` resolves `"line1\nline2"`, Enter on that task's row closes the picker.
7. [integration] After that Enter, the frame shows a listing titled `bash bun run test · running` whose text is `line1` then `line2`.
8. [integration] Enter on a job row calls `host.jobs.logTail(<id>, 40)` and the frame shows a listing titled `<label> · <state>` with the returned text.
9. [integration] Enter on a row whose output is empty shows a listing with text `(no output yet)`.
10. [integration] Enter on a row whose id is unknown to both `host.tasks.get` and `host.jobs.get` shows the notice `<id> is no longer listed` and no listing.
11. [integration] When `tasks.output` rejects with an error whose message is `boom`, the picker is closed and the frame shows an error entry `boom`.
12. [integration] Escape in the jobs picker closes it.
13. [integration] Escape calls neither `tasks.output` nor `jobs.logTail`.
14. [integration] Enter in the jobs picker calls neither `host.switchTo` nor `host.resume`.
15. [integration] With the jobs picker open, a task whose state changes from `running` to `succeeded` (registry `onChange` fired) is redrawn with detail starting `succeeded` on the next render, without reopening the picker.

### US-006

All ACs run on a mounted `ChatApp` and open the picker by typing `/jobs`.

1. [integration] ctrl+x on a running task's row calls `host.tasks.stop("bash-1a2b3c4d")` once.
2. [integration] After that ctrl+x the jobs picker is still open.
3. [integration] ctrl+x on a running job's row whose `canCancel` resolves `{ ok: true }` calls `host.jobs.cancel(<id>)` once and the picker stays open.
4. [integration] ctrl+x on a running job's row whose `canCancel` resolves `{ ok: false, message: "job is not owned by this chat" }` does not call `cancel`.
5. [integration] In that case the picker's note row reads `job is not owned by this chat`.
6. [integration] ctrl+x on an ended row calls neither `stop` nor `cancel`.
7. [integration] In that case the note row reads `<id> is not running`.
8. [integration] When `tasks.stop` throws a `NaxError` with message `[chat] task bash-1a2b3c4d is not running`, the note row shows that message and the picker stays open.
9. [integration] When `jobs.cancel` rejects with message `kill failed`, the note row shows `kill failed` and the picker stays open.
10. [integration] After a warning is shown, a successful ctrl+x on a running row clears the note row.
11. [integration] With the jobs picker open, a task whose state changes from `running` to `stopped` (registry `onChange` fired) is redrawn with detail starting `stopped · ` on the next render.
12. [integration] With two running tasks A (highlighted) and B, after ctrl+x stops A and A moves to the ended group, A is still the highlighted row.
13. [integration] In that state a second ctrl+x does not call `stop` for B.
14. [integration] In that state the note row reads `<A> is not running`.
15. [integration] ctrl+x in the `model` picker stops nothing and leaves the model picker open with its rows unchanged.

### US-007

1. [unit] `footerStripHit({ x: 61, y: 23, footerRow: 23, columns: 80, rightWidth: 20, stripWidth: 7 })` is true (61 is the first strip column, `80 - 20 + 1`).
2. [unit] With the same input and `x: 67` (the last strip column, `80 - 20 + 7`), `footerStripHit` is true.
3. [unit] With the same input and `x: 60` or `x: 68`, `footerStripHit` is false.
4. [unit] With the same input and `y: 22`, `footerStripHit` is false.
5. [unit] With `stripWidth: 0`, `footerStripHit` is false for every `x` on the footer row.
6. [integration] On a mounted `ChatApp` whose host has a running task, pressing ctrl+g opens the jobs picker.
7. [integration] With the model picker open, ctrl+g leaves the model picker open and does not open the jobs picker.
8. [integration] With an approval ask card pending, ctrl+g opens no picker.
9. [integration] With the slash menu shown (the draft is `/`), ctrl+g opens no picker.
10. [integration] On a mounted `ChatApp` whose host has neither `jobs` nor `tasks`, ctrl+g shows the notice `jobs are not available in this session`.
11. [integration] On a mounted `ChatApp` (terminal `columns × rows`, mounted with fake mouse events) whose host has one running task, a left press then release at the strip's first column on row `rows - 1` opens the jobs picker.
12. [integration] A left press and release on the footer row one column left of the strip opens no picker.
13. [integration] A press on the strip followed by a release on a different cell opens no picker.
14. [integration] A right-button press and release on the strip opens no picker.
15. [integration] With an approval ask card pending, a left click on the strip opens no picker.
16. [integration] While a turn is running (the host's `send` has not settled), ctrl+g opens the jobs picker, and Enter on a task row shows its output listing.
17. [integration] While a turn is running, ctrl+g then ctrl+x on a running task row calls `tasks.stop` for that task.

### US-008

None. Removal is verified by the build/static gate (`bun run typecheck` and `bun run lint`), recorded in the story's verification note. Because the PRD schema requires at least one criterion per story, the PRD carries three review-checked criteria for this story (not new tests): the runtime module namespaces of `packages/nax/src/chat/background/index.ts`, `packages/nax/src/chat/jobs/index.ts` and `packages/nax/src/chat/index.ts` no longer expose `formatTasksListing` / `formatJobsListing`.
