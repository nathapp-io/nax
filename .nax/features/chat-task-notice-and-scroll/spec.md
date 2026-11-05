# SPEC: Chat task notices the agent already read, and a scroll-to-bottom marker

Closes: #2802, #2803

## Summary

Two small `nax chat` fixes. First, a background Bash task whose finished output the agent already
read with the `nax-tasks__output` tool no longer queues a completion notice, so it no longer starts
an extra autonomous turn after the agent's turn ends. Second, the transcript viewport shows a bottom
marker whenever it is scrolled up, not only when new lines arrived: `↓ Scroll to bottom (End)` when
nothing is unseen, `↓ <n> new lines (End)` as today when something is. A left-button press on either
marker returns the view to the newest line.

## Motivation

#2802. `BackgroundTasks.finalize` (`packages/nax/src/chat/background/task-registry.ts`) adds every
task that ends `succeeded` or `failed` to its private `unnoticed` map, and only `takeNotice()` ever
removes it. `useJobs` (`packages/nax/src/tui/chat/use-jobs.ts`) delivers `tasks.peekNotice()` as a new
turn whenever the chat is idle. So when the agent starts a background command, the command ends
mid-turn, and the agent reads it with `nax-tasks__output` and reports the result, the notice for that
same task is still delivered once the turn ends, and the agent runs again unprompted.

#2803. `ViewportRows` (`packages/nax/src/tui/chat/TranscriptViewport.tsx`) draws the bottom marker only
when `unseen > 0`. Scrolling up while the transcript is quiet (wheel, PageUp, shift+Up, Home) gives no
sign that the view has left the bottom or that End returns, and the marker cannot be clicked.

## Design

### Part 1 — a read of a finished task counts as seen (#2802)

`ChatBackgroundTasks.output` gains an optional third parameter, `options?: TaskOutputOptions`, where
`TaskOutputOptions` is `{ readonly markSeen?: boolean }`. Only the `nax-tasks` provider's `output` tool
passes `{ markSeen: true }`. The user's task picker (`outputOf` in `packages/nax/src/tui/chat/useChatPicker.ts`)
keeps calling `tasks.output(id, OUTPUT_TAIL_LINES)` with no options: the user looking at a log does not
mean the agent has seen it.

In `BackgroundTasks.output(id, lines, options)`:

1. The existing early return (`!entry` or invalid `lines`) still returns `""` and marks nothing.
2. Synchronously, before `await entry.pending` (the method's first `await`), record whether the task was
   terminal at call time: `entry.record.state` is `succeeded` or `failed`.
3. Read the log as today. A read that throws `CHAT_TASK_READ_FAILED` marks nothing. A successful read,
   including the `ENOENT` case that returns `""`, continues to step 4.
4. If `options?.markSeen === true`, the task was terminal at call time (step 2), and the id is not in
   the current notice snapshot (`this.notice?.ids`), delete the id from `unnoticed`.

A task that was still `running` when the read started is never marked seen, even if it ends during the
read: the tool's JSON reported `state: "running"`, so the agent has not seen its result. A task that is
already in the notice snapshot is left alone: the snapshot is the notice being delivered right now, and
the `ChatBackgroundTasks.peekNotice` contract ("stable completion snapshot until takeNotice consumes
exactly those tasks") stays as it is. A `stopped` task never enters `unnoticed`, so step 4 has nothing to
delete for it.

The provider's `inspectTask` changes one call:
`tasks.output(id, lines)` becomes `tasks.output(id, lines, { markSeen: true })`.

### Part 2 — the scroll-to-bottom marker (#2803)

A new pure function in `packages/nax/src/tui/chat/viewport.ts`:

```typescript
export type ViewportMarker = "unseen" | "scroll";

/** Which bottom-row marker a window of `rows` rows draws for this state, if any. */
export function viewportMarker(
  state: { readonly offset: number; readonly unseen: number },
  rows: number,
): ViewportMarker | undefined {
  if (state.unseen > 0) return "unseen";
  if (state.offset > 0 && rows >= MIN_SCROLL_MARKER_ROWS) return "scroll";
  return undefined;
}
```

`MIN_SCROLL_MARKER_ROWS` is `2`. In a one-row window the scroll marker would replace the only line
of content, so a one-row window draws only the `unseen` marker, as today.

`ViewportRows` draws its marker row from `viewportMarker(...)`. It replaces the `unseen > 0` check:
- `"unseen"`: the existing text `` `${UNSEEN_MARKER} ${unseen} ${UNSEEN_LABEL}` `` (`↓ 3 new lines (End)`), unchanged.
- `"scroll"`: the new text `` `${UNSEEN_MARKER} ${SCROLL_LABEL}` ``, where `SCROLL_LABEL` is `"Scroll to bottom (End)"`, giving `↓ Scroll to bottom (End)`.
- Both use the same muted colour, `wrap="truncate"` and the same last-row placement as the unseen
  marker today.

`transcriptPointAt` (`packages/nax/src/tui/chat/selection.ts`) treats the marker row the same way for
both kinds. Its `marker` count becomes `viewportMarker({ offset, unseen }, height) !== undefined ? 1 : 0`,
so a press, drag or click on a scroll-marker row maps to no transcript line, exactly as an
unseen-marker row does today.

A new exported function in `selection.ts`:

```typescript
/** True when the cell (x, y) is the bottom marker row ViewportRows drew for this geometry. */
export function markerRowAt(geometry: ViewportGeometry, x: number, y: number): boolean {
  const row = y - 1 - geometry.top;
  return x >= 1 && row === geometry.height - 1 && viewportMarker(geometry, geometry.height) !== undefined;
}
```

`TranscriptViewport` already subscribes to `mouse` for wheel events while `active`. That same listener
also handles a `press` with `button === "left"`: when `markerRowAt(geometry, event.x, event.y)` is
true, it folds `{ type: "end" }` into the state, the same action the End key uses. A press anywhere else
does nothing in this listener; text selection stays in `useMouseSelection` and is unchanged. The effect
subscribes on `[active, mouse]` only, so the listener must not use a `geometry` captured by the render
closure (it would keep the mount-time offset of 0): it derives the geometry from the latest state,
either inside the `setMemory` updater from `previous` and the current `top` (held in a ref), or from a
`latest` ref as `useMouseSelection` does. Because the check is `viewportMarker(...) !== undefined`, a
left press on the existing `↓ <n> new lines (End)` row also returns to the newest line.
`useMouseSelection` already starts no selection on a cell that maps to no transcript point
(`startSelection` sets `dragging` false), so the press that jumps to the bottom starts no selection, and
its release copies nothing and triggers no `onClick`.

### Integration

Read-only (verified, unchanged):

- `useJobs(host, { idle, deliver, note })` in `packages/nax/src/tui/chat/use-jobs.ts`. It delivers
  `tasks.peekNotice()` only while idle and consumes it with `takeNotice()` after `deliver` resolves.
- `BackgroundTasks.peekNotice()` / `takeNotice()` and `finalize` in `task-registry.ts`.
- `outputOf(host, id)` in `packages/nax/src/tui/chat/useChatPicker.ts`: calls `tasks.output(id, OUTPUT_TAIL_LINES)`.
- `reduceViewport(state, action, total, height)` and `INITIAL_VIEWPORT` in `viewport.ts`; the `end` action returns `INITIAL_VIEWPORT`.
- `useMouseSelection(input)` and `startSelection` in `packages/nax/src/tui/chat/use-mouse-selection.ts`.

Changed (the baseline exists only to locate the code; implement the target):

- `ChatBackgroundTasks.output` in `packages/nax/src/chat/background/task-types.ts`
  - Baseline: `output(id: string, lines?: number): Promise<string>`
  - Target: `output(id: string, lines?: number, options?: TaskOutputOptions): Promise<string>`, with
    `export interface TaskOutputOptions { readonly markSeen?: boolean }` in the same file and re-exported
    from `packages/nax/src/chat/background/index.ts`.
- `BackgroundTasks.output` in `task-registry.ts`: target behaviour as in Part 1.
- `inspectTask` in `packages/nax/src/chat/background/tasks-provider.ts`: target passes `{ markSeen: true }`.
- `ViewportRows` in `TranscriptViewport.tsx`
  - Baseline: `showingUnseen = unseen > 0`
  - Target: the marker row is drawn from `viewportMarker({ offset, unseen }, rows)`; `ViewportRowsProps`
    gains `readonly offset: number`.
- `transcriptPointAt` in `selection.ts`
  - Baseline: `const marker = unseen > 0 ? 1 : 0`
  - Target: `const marker = viewportMarker({ offset, unseen }, height) !== undefined ? 1 : 0`.
- `TranscriptViewport` mouse effect: target also handles the left-button marker press as above.

### Failure Handling

| Input | Behaviour |
|:--|:--|
| `output` with `markSeen` on an unknown id or invalid `lines` (for example `0`) | returns `""`, marks nothing (existing early return). |
| `output` with `markSeen` whose log read throws | throws `CHAT_TASK_READ_FAILED` as today and marks nothing. |
| `output` with `markSeen` whose log file is missing (`ENOENT`) | returns `""` as today and marks a terminal task seen. |
| a left press on the marker row while the viewport is inactive | ignored; the listener is not subscribed while inactive (existing behaviour). |

## Out of Scope

- Marking a task seen when the agent calls `nax-tasks__list`. A list shows the state and exit code but not the output, so a notice still asks the agent to read it.
- Dropping a task from a notice snapshot that was built but whose delivery `useJobs` declined (`deliver` returned false). That race is rare and the existing snapshot contract is kept unchanged.
- Any change to `MAX_CONSECUTIVE_TASK_NOTICE_TURNS`, to job notices (`host.jobs`), or to run-ask notices (`host.runAsks`).
- Any change to the notice text built by `buildBackgroundTaskNotice`.
- Changing the wheel step (`WHEEL_LINES`, 3 lines) or adding a scroll position, percentage or scrollbar to the marker.
- Showing the scroll marker in a one-row window; only the existing unseen marker can appear there.
- Making the marker clickable by any button other than the left button, or by a release or drag.

## Stories

### US-001: A finished task the agent already read queues no notice

No dependencies. Workdir: `packages/nax`

Add `TaskOutputOptions` and the `markSeen` rule to `BackgroundTasks.output`, and make the `nax-tasks`
provider's `output` tool pass `{ markSeen: true }`, so a task whose finished output the agent read
starts no extra turn. The user's picker read is unchanged and never suppresses a notice.

### US-002: Scroll-to-bottom marker whenever the transcript is scrolled up

No dependencies. Workdir: `packages/nax`

Add `viewportMarker` and `MIN_SCROLL_MARKER_ROWS` to `viewport.ts`, draw the `↓ Scroll to bottom (End)`
marker in `ViewportRows`, make `transcriptPointAt` skip that row, add `markerRowAt`, and make a left
press on either marker (scroll or unseen) in `TranscriptViewport` run the `end` action.

### Context Files

**US-001**
- `packages/nax/src/chat/background/task-registry.ts` - `output`, `finalize`, `peekNotice`, `takeNotice`
- `packages/nax/src/chat/background/task-types.ts` - `ChatBackgroundTasks` interface
- `packages/nax/src/chat/background/tasks-provider.ts` - `inspectTask`, the agent's `output` tool
- `packages/nax/test/unit/chat/background/task-registry-notices.test.ts` - notice fixture to extend
- `packages/nax/test/unit/chat/background/tasks-provider.test.ts` - provider fixture and `run` helper to extend

**US-002**
- `packages/nax/src/tui/chat/viewport.ts` - reducer and `visibleRange`
- `packages/nax/src/tui/chat/TranscriptViewport.tsx` - `ViewportRows` and the mouse effect
- `packages/nax/src/tui/chat/selection.ts` - `transcriptPointAt`, `ViewportGeometry`
- `packages/nax/src/tui/chat/use-mouse-selection.ts` - `startSelection` (press on a non-line cell)
- `packages/nax/test/ui/chat/transcript-viewport.test.tsx` - viewport harness, `fakeMouse`, key sequences
- `packages/nax/test/unit/tui/chat/viewport.test.ts` - reducer unit tests to extend with `viewportMarker`
- `packages/nax/test/unit/tui/chat/selection.test.ts` - `geometry` fixture to extend with `markerRowAt`

### Modifies

**US-001**

None. The new parameter is optional, so every test fake that implements `ChatBackgroundTasks.output` with fewer parameters still type-checks, and no existing test reads a finished task through the provider and then expects its notice.

**US-002**
- `packages/nax/test/ui/chat/transcript-viewport.test.tsx` - the tests "AC-4 pageUp keeps the newest line of the previous page in the frame", "AC-7 shift+upArrow moves the view up one line", "AC-8 home shows the first page", "US003 AC-13 scrolls up three rows and down again wherever the pointer is" and "US003 AC-17 PageUp without a mouse keeps the one-row overlap" assert the full row list of a scrolled-up window with nothing unseen, where the last row used to be a transcript line. That row is now `↓ Scroll to bottom (End)`. Replace each expected last row with `↓ Scroll to bottom (End)` and keep every row above it unchanged; for example AC-4 becomes `["line 12", "line 13", "line 14", "line 15", "↓ Scroll to bottom (End)"]` and US003 AC-13 after `wheelUp` becomes `labels(37, 9)` followed by `↓ Scroll to bottom (End)`. Every row list taken at the bottom (offset 0) stays exactly as it is.

### Seams

- US-001: the `nax-tasks` provider's `output` tool is the agent's only route to `markSeen`; AC-8 enters at that tool's `run` with a real registry from `createHostTasks`, not at `BackgroundTasks.output`.
- US-002: `markerRowAt` and `viewportMarker` are new exports consumed by `TranscriptViewport` in the same story; AC-11 and AC-12 enter at a mounted `TranscriptViewport` and send a `fakeMouse` press, not at the helpers.

## Acceptance Criteria

### US-001

1. [unit] Calling `tasks.output(id, undefined, { markSeen: true })` on a task that ended with exit code 0 (state `succeeded`) before the call, and before any `peekNotice()`, makes a following `tasks.peekNotice()` return `undefined`.
2. [unit] Calling `tasks.output(id, undefined, { markSeen: true })` on a task that ended with exit code 1 (state `failed`) before the call makes a following `tasks.peekNotice()` return `undefined`.
3. [unit] Calling `tasks.output(id)` with no options on a task that has ended `succeeded` leaves the task in the notice: `tasks.peekNotice()` afterwards returns text that names that task's id.
4. [unit] Calling `tasks.output(id, undefined, { markSeen: true })` while the task is still `running`, and then ending the task with exit code 0, leaves a notice: `tasks.peekNotice()` returns text that names that task's id.
5. [unit] With `_backgroundTaskDeps.readLog` held on a pending promise, starting `tasks.output(id, undefined, { markSeen: true })` on a `running` task, then ending the task with exit code 0, then resolving the read, leaves a notice: `tasks.peekNotice()` returns text that names that task's id.
6. [unit] When two tasks have ended `succeeded` and `tasks.output(firstId, undefined, { markSeen: true })` is called for only the first, `tasks.peekNotice()` returns text that names the second id and does not name the first id.
7. [unit] When `tasks.peekNotice()` has already returned a snapshot naming a task, calling `tasks.output(id, undefined, { markSeen: true })` for that task leaves the snapshot in place: the next `tasks.peekNotice()` returns the identical string, and `tasks.takeNotice()` returns that same string.
8. [unit] Running the `nax-tasks` provider's `output` tool (from `createHostTasks(...).provider`) with `{ task: id }` on a task that ended `failed` before the call makes the same registry's `peekNotice()` return `undefined`.
9. [unit] Running the `nax-tasks` provider's `output` tool with `{ task: id }` on a `running` task, then ending the task with exit code 1, leaves a notice: the registry's `peekNotice()` returns text that names that task's id.
10. [unit] When `_backgroundTaskDeps.readLog` rejects with an error whose `code` is `"EACCES"`, `tasks.output(id, undefined, { markSeen: true })` on a `succeeded` task rejects with a `NaxError` whose code is `CHAT_TASK_READ_FAILED`, and `tasks.peekNotice()` afterwards still names that task's id.
11. [unit] When `_backgroundTaskDeps.readLog` rejects with an error whose `code` is `"ENOENT"`, `tasks.output(id, undefined, { markSeen: true })` on a `succeeded` task resolves to `""` and `tasks.peekNotice()` afterwards returns `undefined`.
12. [unit] `tasks.output("bash-00000000", undefined, { markSeen: true })` for an id the registry never adopted resolves to `""`, and a different task that ended `succeeded` is still named by `tasks.peekNotice()`.
13. [unit] `tasks.output(id, 0, { markSeen: true })` on a task that ended `succeeded` resolves to `""`, and `tasks.peekNotice()` afterwards still names that task's id.
14. [unit] With `_backgroundTaskDeps.appendLog` held on a pending promise and one output chunk appended to a `running` task (so `entry.pending` is unresolved), starting `tasks.output(id, undefined, { markSeen: true })`, then ending the task with exit code 0, then resolving the held write, leaves a notice: `tasks.peekNotice()` returns text that names that task's id.
15. [unit] `TaskOutputOptions` is importable as a type from `@/chat/background`, and an object `{ markSeen: true }` typed as `TaskOutputOptions` is accepted as the third argument of `ChatBackgroundTasks.output`.

### US-002

1. [unit] `viewportMarker({ offset: 0, unseen: 0 }, 5)` returns `undefined`.
2. [unit] `viewportMarker({ offset: 4, unseen: 0 }, 5)` returns `"scroll"`.
3. [unit] `viewportMarker({ offset: 4, unseen: 3 }, 5)` returns `"unseen"`.
4. [unit] `viewportMarker({ offset: 1, unseen: 0 }, 1)` returns `undefined`, `viewportMarker({ offset: 1, unseen: 2 }, 1)` returns `"unseen"`, and `viewportMarker({ offset: 1, unseen: 0 }, 2)` returns `"scroll"`.
5. [unit] `transcriptPointAt({ top: 3, height: 10, total: 50, offset: 3, unseen: 0 }, 1, 13)` returns `undefined` (the scroll-marker row), and the same geometry at `y = 12` returns `{ line: 45, column: 0 }`.
6. [unit] `markerRowAt({ top: 3, height: 10, total: 50, offset: 3, unseen: 0 }, 1, 13)` returns `true`; the same geometry at `y = 12` returns `false`; and `markerRowAt({ top: 3, height: 10, total: 50, offset: 0, unseen: 0 }, 1, 13)` returns `false`.
7. [unit] A mounted `TranscriptViewport` with 20 numbered lines and `height` 5 shows the rows `["line 12", "line 13", "line 14", "line 15", "↓ Scroll to bottom (End)"]` after one PageUp.
8. [unit] A mounted `TranscriptViewport` with 20 numbered lines and `height` 5, after one PageUp and a rerender with 23 lines, shows `↓ 3 new lines (End)` as its last row and no row containing `Scroll to bottom`.
9. [unit] A mounted `TranscriptViewport` with 20 numbered lines and `height` 5, after one PageUp and then End, shows `["line 16", "line 17", "line 18", "line 19", "line 20"]` with no row starting with `↓`.
10. [unit] A mounted `TranscriptViewport` with 20 numbered lines and `height` 1, after shift+Up, shows the single row `line 19`.
11. [unit] A mounted `TranscriptViewport` with 50 lines, `height` 10, `top` 0 and a `fakeMouse`, after one `wheelUp`, then a `press` with `button: "left"` at `x: 1, y: 10`, shows the newest page (`line-40` through `line-49`) with no row starting with `↓`.
12. [unit] A mounted `TranscriptViewport` with 50 lines, `height` 10, `top` 0, a `fakeMouse` and an `onCopy` and `onClick` spy, after one `wheelUp` and a left `press` then `release` at `x: 1, y: 10`, calls neither `onCopy` nor `onClick`.
13. [unit] A mounted `TranscriptViewport` with 50 lines, `height` 10, `top` 0 and a `fakeMouse`, after one `wheelUp` and a left `press` at `x: 1, y: 5` (a transcript line, not the marker), still shows `↓ Scroll to bottom (End)` as its last row.
14. [unit] A mounted `TranscriptViewport` with 50 lines, `height` 10, `top` 0 and a `fakeMouse`, after one `wheelUp` and a rerender with `active` false, then a left `press` at `x: 1, y: 10`, still shows `↓ Scroll to bottom (End)` as its last row.
15. [unit] A mounted `TranscriptViewport` 10 columns wide, with 20 numbered lines and `height` 5, after one PageUp, shows a last row that starts with `↓ Scroll` and exactly 5 rows in total.
16. [unit] A mounted `TranscriptViewport` with 20 numbered lines, `height` 5, `top` 0 and a `fakeMouse`, after one PageUp, a rerender with 23 lines (last row `↓ 3 new lines (End)`) and a left `press` at `x: 1, y: 5`, shows `["line 19", "line 20", "line 21", "line 22", "line 23"]` with no row starting with `↓`.
