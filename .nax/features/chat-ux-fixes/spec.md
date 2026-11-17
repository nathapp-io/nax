# SPEC: chat-ux-fixes — repaint the chat screen after a resize, show long durations as h/m/s, and steer a task that ends mid-turn into that turn

Closes: #2973, #2974, #2975

## Summary

Three independent chat screen fixes. After a terminal resize, `renderChat` clears the alternate screen and has Ink redraw the whole frame through a new `repaint()` on Ink's instance, added to the repo's existing Ink patch, so no row of the previous frame is left behind (#2973). The running line, the finished-turn stats row, the `Thought for` row and the finished agent card state durations as `42s`, `20m 55s` or `1h 46m 19s` through one shared formatter, instead of a bare second count such as `6379s` (#2974). A background task that ends while a turn is running is sent into that turn as a steer, so the agent sees it at its next step and no new turn starts for it after the turn ends; a turn that ends before taking the steer leaves the notice queued, and it starts a turn as it does today (#2975).

## Motivation

Seen on nax 0.92.7 chat during long agent turns:

1. **Resize leaves the previous frame on screen (#2973).** After the window was resized while a Bash tool ran, the screen showed `Running Bash… (1255s …)` above `Running Bash… (1263s …)`, with an extra set of divider rules and an extra prompt row. The chat draws on the alternate screen with Ink's incremental renderer (`incrementalRendering: true` in `renderChat`), which rewrites rows relative to the previous frame's row count and skips rows it believes are unchanged. Ink 6.7's own `resized` handler erases the previous frame only when the width shrinks, and counts its rows at the old width; rows the terminal re-wrapped take more than that, so the erase stops short. `ChatApp` only re-measures on `resize` (`setSize(terminalSize(stdout))`). Ink offers no public way to redraw every row: `Instance.clear()` erases and then calls `log.sync(lastOutput)` (`ink.js:444-450`), so Ink still believes the old frame is drawn and the next render writes nothing for unchanged rows. A spike against real Ink 6.7.0 confirmed it: `clear()`, an external screen clear and `rerender` wrote no rows; resetting the log's previous-frame state and `lastOutput`, then calling `onRender`, wrote every row.
2. **Durations are a bare second count (#2974).** A long Bash call reads `Running Bash… (6379s · …)`, and the finished turn reads `32.1 tok/s · 36.0k out · 5229s · 22:00`. Four places format seconds by hand: `workingDetail` in `tui/chat/chat-status.ts`, `turnStatsText` in `tui/chat/turn-stats.ts`, `thoughtHeader` in `tui/chat/layout.ts`, and `agentSummary` in `tui/chat/tool-card.ts`.
3. **A task that already ended starts a new turn (#2975).** A background command ended during an 87-minute turn, and the agent acted on its result in that turn. When the turn ended, `useJobs` delivered `[nax-tasks] background command <id> (...) ended: ...` as a new turn, and the agent re-reported a result it had already handled. Today a queued task notice is dropped only when the agent reads that task through `nax-tasks__output` after the task ended (`BackgroundTasks.markSeen`); reading the log or the command's output file with Bash, or reading it while the task was still running, leaves the notice queued. The native session already accepts mid-turn input (`AgentSession.steer`, used by ctrl+s), and its `applied` promise says whether the turn took the text. Sending the notice as a steer makes "the agent saw it" exact: if the turn took it, nothing is left to deliver; if not, the notice is still queued.

User rulings (2026-11-17): fix #2975 by steering into the running turn, and keep today's behaviour for ACP sessions, which cannot be steered. The job panel's elapsed time keeps its format.

## Design

### Approach

**US-001 — repaint after a resize.**

*Ink patch.* `patches/ink@6.7.0.patch` (root `patchedDependencies`) keeps its existing `log-update.js` `cursorUp` hunk and gains these additions to ink 6.7.0's `build/` files:

- `log-update.js`: both `createStandard` and `createIncremental` get a `render.reset` that forgets the previous frame without writing anything and without touching the cursor's visibility:
  ```js
  // createStandard
  render.reset = () => {
      previousOutput = '';
      previousLineCount = 0;
      previousCursorPosition = undefined;
      cursorWasShown = false;
  };
  // createIncremental
  render.reset = () => {
      previousOutput = '';
      previousLines = [];
      previousCursorPosition = undefined;
      cursorWasShown = false;
  };
  ```
- `ink.js`: a `repaint` method on `Ink`:
  ```js
  repaint() {
      if (this.isUnmounted) {
          return;
      }
      this.log.reset();
      this.lastOutput = '';
      this.lastOutputToRender = '';
      this.onRender();
  }
  ```
- `render.js`: the returned instance gains `repaint: () => { instance.repaint(); }`.
- `render.d.ts`: `Instance` gains `repaint: () => void;` with the doc comment `Forget the drawn frame and write the whole current frame again.`

The patch is regenerated with `bun patch ink@6.7.0` (it prints the directory to edit) and `bun patch --commit <that directory>`, then re-applied with `bun install`. Ink stays pinned at 6.7.0 (`check-bundle-externals` rule 5).

*renderChat.* `tui/chat/alt-screen.ts` adds:

```ts
/** Erase the whole alternate screen and home the cursor, so a full frame redraws from 1:1. */
export const CLEAR_ALT_SCREEN = "\u001b[2J\u001b[H";
```

It is re-exported from the `tui/chat/index.ts` barrel beside `ENTER_ALT_SCREEN`. `tui/chat/index.ts` exports `RESIZE_REPAINT_MS = 50` and adds one dependency to `_renderChatDeps`:

```ts
/** Subscribe to terminal resizes; the returned remover unsubscribes. */
onResize: (handler: () => void): (() => void) => {
  process.stdout.on("resize", handler);
  return () => {
    process.stdout.off("resize", handler);
  };
},
```

After `_renderChatDeps.render` returns, `renderChat` subscribes once with `_renderChatDeps.onResize`. Each resize event, while the screen is not restored, clears a pending repaint handle with `_renderChatDeps.clearTimeout` and arms a new one with `_renderChatDeps.setTimeout(repaint, RESIZE_REPAINT_MS)`, so a burst of resize events repaints once, after the last one; by then `ChatApp`'s own resize listener has committed the frame at the new size. `repaint` does nothing once restored; otherwise it calls `_renderChatDeps.write(CLEAR_ALT_SCREEN)` and then `instance.repaint()`, in that order. `instance.clear()` and `instance.rerender()` are not used for this.

`restore()` calls the resize remover once and, only when a repaint handle is armed, clears it with `_renderChatDeps.clearTimeout`; with none armed it makes no `clearTimeout` call, so the existing exact-order assertions in `index.test.tsx` keep holding. The repaint handle is a separate variable from the title-animation `timer`; neither path clears the other's handle. The repaint uses `setTimeout` rather than `Bun.sleep` because the handle must be cancellable (the `forbidden-patterns-source` exception); the call site says so in a comment, as `armFrame` does.

*Real-terminal check.* `test/integration/tui/chat/resize.test.ts` drives the real `renderChat` in tmux against an unresized reference pane. Its fixture (`test/fixtures/chat-pty/host.ts`) captures only bytes Ink writes through its stream, so `CLEAR_ALT_SCREEN`, written by `_renderChatDeps.write`, never reaches its `/bytes` check for `\x1b[2J`; its existing cases keep their assertions. US-001 adds one width case to it. tmux may not re-wrap the alternate screen when it narrows, so that case may pass before the fix as well: it is a regression guard, and the real-Ink fixture is the proof that `repaint` writes every row.

**US-002 — one duration format.** A new file `tui/chat/duration.ts`:

```ts
/**
 * A duration as the chat states it: `42s` under a minute, `20m 05s` under an hour, then
 * `1h 06m 19s`. Units after the first are two digits.
 */
export function formatDuration(ms: number): string;
```

It floors `ms` to whole seconds; a negative or non-finite `ms` formats as `0s`. Under 60 seconds it returns `<s>s`. Under 3600 seconds it returns `<m>m <ss>s`. From 3600 seconds it returns `<h>h <mm>m <ss>s`, with no unit above hours (`25h 00m 00s`). The four call sites use it:

- `workingDetail` (`chat-status.ts`): `formatDuration(elapsed)` replaces `` `${Math.floor(elapsed / MILLIS_PER_SECOND)}s` `` in both the full and the compact form. `MILLIS_PER_SECOND` in `chat-status.ts` is then unused and is deleted.
- `turnStatsText` (`turn-stats.ts`): `formatDuration(input.elapsedMs)` replaces `` `${wholeSeconds(input.elapsedMs)}${SECONDS_SUFFIX}` ``. `wholeSeconds` and `SECONDS_SUFFIX` in `turn-stats.ts` are then unused and are deleted; `MILLIS_PER_SECOND` there stays (the rate uses it).
- `thoughtHeader` (`layout.ts`): `Thought for <formatDuration(seconds * 1000)>`, where `seconds` is still `secondsBetween(entry.startedAt, entry.endedAt)`. `SECONDS_SUFFIX` in `layout.ts` is then unused and is deleted.
- `agentSummary` (`tool-card.ts`): `(<N> tool uses · <formatDuration(seconds * 1000)>)`, with the same `secondsBetween`.

Every duration under 60 seconds renders exactly as it does today.

**US-003 — steer a task notice into the running turn.** `useJobs` (`tui/chat/use-jobs.ts`) gains a steer path for background task notices only; job notices and run-ask notices keep today's delivery. It keeps two refs: a pending flag, and the refused notice text.

On each render where `idle` is true, the refused text is cleared first. On each render where `idle` is false:

1. If a steer is pending, or a delivery from the idle path is in flight (`inFlight.current`, which stays set until the notice turn it started has settled and `takeNotice` has run), or `host.steer` is undefined, or `tasks?.peekNotice()` returns `undefined`, do nothing. A notice turn therefore never steers its own notice into itself.
2. If the head notice text equals the refused text, do nothing.
3. Otherwise call `host.steer(notice)` once:
   - `accepted`: set the pending flag. When `applied` resolves `true`, call `tasks.takeNotice()` and `note(steeredTaskNoticeLine(summary))`, where `summary` is `summarizeBackgroundNotice(notice)` from `@/prompts`, or `background task notice` when it returns `undefined`. When `applied` resolves `false` or rejects, store the notice text as refused and leave the notice queued, so the same notice is not steered again before the chat is idle. Either way clear the pending flag and, while mounted, refresh, so the next head is considered.
   - `unsupported` or `no_turn`: store the notice text as refused; leave the notice queued.

The idle path (today's delivery as a new turn) keeps its order: run asks, then job notices, then task notices. While the pending flag is set it skips only the task source; a run ask or a job notice is still delivered. A task notice skipped because a steer is pending is not the guard's hold: it does not add the `taskNoticeHeldLine` row and does not set `heldAnnounced`. A steered notice does not count toward the consecutive task-turn guard (`taskTurns`) and does not reset it; it is not a turn. Steering also happens when `taskNoticeTurns` is `0`: that setting stops task notices from starting turns, and a steer starts none. A native turn closes its steer channel when it settles (`steer-channel.ts`: pending steers resolve `false`), so a pending flag clears when the turn it was steered into ends.

```ts
/** The transcript row for a task notice the running turn took as a steer. */
export function steeredTaskNoticeLine(summary: string): string {
  return `${summary} · sent into the running turn`;
}
```

`ChatApp.tsx` is not edited: `useJobs` already receives `host`, and `note` already appends a notice row.

### Test placement

US-001 adds its `renderChat` tests to `test/ui/chat/index.test.tsx`, its real-Ink repaint test to `test/ui/chat/ink-incremental-render.test.tsx` with a new fixture `test/fixtures/ink-incremental/repaint.mjs` (modelled on `two-frames.mjs`), and its PTY width case to `test/integration/tui/chat/resize.test.ts`. US-002 adds `test/unit/tui/chat/duration.test.ts` for `formatDuration` and consumer tests to `test/unit/tui/chat/working-line-fit.test.ts`, `test/unit/tui/chat/turn-stats.test.ts`, a new `test/unit/tui/chat/layout-duration.test.ts` (`layout.test.ts` is at 790 of its 800 lines) and `test/unit/tui/chat/tool-card.test.ts`. Tests import `formatDuration` from `@/tui/chat/duration`; `@/log-format` exports an unrelated `formatDuration`. US-003 adds its tests to `test/ui/chat/task-notices.test.tsx`; its local `mount()` gains a `steer` parameter passed through to `mountChatPicker`. A file that would pass 650 lines is split by describe block into `<module>-<concern>.test.ts(x)`.

### Integration

Read-only symbols, verified on `main` `b3a8762eb`:

- `ChatHost.steer?(text: string): SteerResult` (`packages/nax/src/chat/chat-host-types.ts:98`).
- `SteerResult` = `{ status: "accepted"; steerId: string; applied: Promise<boolean> } | { status: "unsupported" } | { status: "no_turn" }` (`packages/nax-agent/src/session/steer-channel.ts:24`). `applied` resolves `true` when the loop took the text and `false` when the turn ended with it pending.
- `ChatBackgroundTasks.peekNotice()` / `takeNotice()` (`chat/background/task-types.ts:61`): `peekNotice` returns a stable snapshot until `takeNotice` consumes exactly those tasks.
- `summarizeBackgroundNotice(text): string | undefined` (`prompts/builders/notice-summary.ts:63`, exported from `@/prompts`).
- `secondsBetween(startedAt, endedAt): number` (`tui/chat/tool-card.ts:276`).
- Ink 6.7.0 `Ink.onRender`, `Ink.isUnmounted`, `lastOutput`, `lastOutputToRender` (`build/ink.js`), and log-update's per-creator previous-frame state (`build/log-update.js`).

Symbols this feature changes. The baseline only locates the code; it is never the interface to implement:

- Ink `Instance` (ink `build/render.d.ts`) — Target: gains `repaint: () => void`, through the patch.
- `_renderChatDeps` (`tui/chat/index.ts:23`) — Target: gains `onResize(handler): () => void`.
- `renderChat` (`tui/chat/index.ts`) — Target: subscribes to resizes after render and repaints as described; `restore()` also unsubscribes and cancels a pending repaint.
- `workingDetail` (`tui/chat/chat-status.ts:381`) — Baseline: `` `${Math.floor(elapsed / MILLIS_PER_SECOND)}s` ``. Target: `formatDuration(elapsed)`.
- `turnStatsText` (`tui/chat/turn-stats.ts:164`) — Baseline: `` `${wholeSeconds(input.elapsedMs)}${SECONDS_SUFFIX}` ``. Target: `formatDuration(input.elapsedMs)`.
- `thoughtHeader` (`tui/chat/layout.ts:155`) — Baseline: `` `${seconds}${SECONDS_SUFFIX}` ``. Target: `formatDuration(seconds * 1000)`.
- `agentSummary` (`tui/chat/tool-card.ts:287`) — Baseline: `` `${secondsBetween(...)}s` ``. Target: `formatDuration(secondsBetween(...) * 1000)`.
- `useJobs` (`tui/chat/use-jobs.ts:28`) — Target: the steer path, the refused text, and the task-only pending wait on the idle path described above.

### Failure Handling

| Case | Behaviour |
|:--|:--|
| `host.steer` throws | `useJobs` logs a warning (`getLogger()?.warn("chat", "Background notice steer failed; notice retained", { error })`), stores the notice text as refused, and leaves the notice queued; no steer is pending. |
| `applied` rejects | Treated as `false`: the notice text is stored as refused, the notice stays queued, the pending flag clears, and a warning is logged with the same message. |
| `applied` never settles | Only task notices wait; run asks and job notices are still delivered when idle. |
| A repaint timer fires after `restore()` | It calls neither `_renderChatDeps.write` nor `instance.repaint()`. |
| `Ink.repaint()` after unmount | Returns without writing. |

## Out of Scope

- Steering for ACP sessions: they have no mid-turn input (`steer` answers `unsupported`), so a task that ends during an ACP turn still starts a new turn after it, as today.
- Steering job notices and run-ask notices: only background task notices take the steer path.
- Marking a task seen when the agent reads its log or output files with Bash or another tool instead of `nax-tasks__output`.
- Changing the job panel's elapsed time (`formatElapsed` in `tui/chat/layout-job.ts`, `1h 46m`) or the run TUI's `formatElapsed` in `tui/App.tsx`.
- Editing `tui/chat/ChatApp.tsx`: it is over the 600-line source cap and may not grow; US-001 works in `renderChat` and US-003 in `useJobs`.
- Changing Ink's own `resized` handler, upgrading Ink, or widening its pin: the patch only adds `reset` and `repaint`.
- Repainting on anything other than a resize: status and stream ticks keep incremental rendering.

## Stories

### US-001 — the chat screen repaints in full after a terminal resize

Workdir: packages/nax. No dependencies.

Add `repaint()` to Ink's instance through the repo's Ink patch. Add `CLEAR_ALT_SCREEN`, `RESIZE_REPAINT_MS` and `_renderChatDeps.onResize`, and have `renderChat` repaint once after a burst of resize events: clear the alternate screen, then `instance.repaint()`. Unsubscribe and cancel on restore.

### US-002 — chat durations read as h/m/s

Workdir: packages/nax. No dependencies.

Add `formatDuration` in `tui/chat/duration.ts` and use it on the running line, the turn stats row, the `Thought for` row and the finished agent card.

### US-003 — a task notice that ends mid-turn is steered into the running turn

Workdir: packages/nax. No dependencies.

Add the steer path to `useJobs` for background task notices, with the refused-text memory, the task-only pending wait on the idle path, and the `steeredTaskNoticeLine` transcript row.

### Context Files

**US-001**
- `packages/nax/src/tui/chat/index.ts`
- `packages/nax/src/tui/chat/alt-screen.ts`
- `patches/ink@6.7.0.patch`
- `packages/nax/test/ui/chat/ink-incremental-render.test.tsx`
- `packages/nax/test/integration/tui/chat/resize.test.ts`

**US-002**
- `packages/nax/src/tui/chat/chat-status.ts`
- `packages/nax/src/tui/chat/turn-stats.ts`
- `packages/nax/src/tui/chat/layout.ts`
- `packages/nax/src/tui/chat/tool-card.ts`

**US-003**
- `packages/nax/src/tui/chat/use-jobs.ts`
- `packages/nax/src/chat/background/task-registry.ts`
- `packages/nax/src/prompts/builders/notice-summary.ts`
- `packages/nax/test/ui/chat/task-notices.test.tsx`
- `packages/nax-agent/src/session/steer-channel.ts`

### Creates

**US-001**
- `packages/nax/test/fixtures/ink-incremental/repaint.mjs`

**US-002**
- `packages/nax/src/tui/chat/duration.ts`
- `packages/nax/test/unit/tui/chat/duration.test.ts`
- `packages/nax/test/unit/tui/chat/layout-duration.test.ts`

**US-003**
None.

### Modifies

**US-001**
- `packages/nax/test/ui/chat/index.test.tsx` — the mount helper stubs only `stdin`, `createMouseInput`, `render`, `write` and the timer deps, so the new `onResize` default would add a real `process.stdout` resize listener in every test; the helper stubs `_renderChatDeps.onResize` with one that records the handler and returns a recording remover, and its fake instance gains a recording `repaint`; its existing `afterEach` restore covers the stub, and every existing expectation is unchanged.

**US-002**
None. No existing test asserts a duration of 60 seconds or more on the running line, the turn stats row, the `Thought for` row or the agent card, and every duration under 60 seconds renders as before.

**US-003**
- `packages/nax/test/helpers/chat-picker.tsx` — `MountOptions` has no `steer`, so a test cannot give the fake host a steerable turn; `MountOptions` gains `steer?: ChatHost["steer"]`, the fake host spreads it in only when given, and a mount without it builds the same host as before.

### Seams

- US-001: `renderChat` consumes `_renderChatDeps.onResize` and Ink's new `Instance.repaint`. The `index.test.tsx` ACs mount through `renderChat` with the dep stubbed and fire the recorded handler; the real-Ink fixture AC proves `repaint` writes the whole frame; the tmux AC drives a real resize through the default `onResize`.
- US-002 creates `formatDuration`; `workingLine`, `turnStatsText`, the layout of a finished thinking entry and the agent card consume it. US-002's consumer ACs assert each one's rendered text for a duration of a minute or more.
- US-003: `useJobs` consumes the existing `ChatHost.steer`. US-003's ACs mount the chat screen with a fake host whose `steer` is a recording stub, start a user turn, end a background task, and assert the call, including no repeat call on later renders.

## Acceptance Criteria

### US-001

1. [unit] `CLEAR_ALT_SCREEN` imported from `@/tui/chat` equals `"\u001b[2J\u001b[H"`.
2. [unit] `renderChat(props)` with `_renderChatDeps.onResize` stubbed calls `onResize` exactly once, after `_renderChatDeps.render` returned.
3. [unit] Calling the recorded resize handler once arms one timeout through `_renderChatDeps.setTimeout` with a delay of `RESIZE_REPAINT_MS` (50), and neither writes `CLEAR_ALT_SCREEN` nor calls `instance.repaint()` before that timeout fires.
4. [unit] Firing the armed repaint timeout writes `CLEAR_ALT_SCREEN` through `_renderChatDeps.write` once and then calls `instance.repaint()` once, in that order, and calls neither `instance.clear()` nor `instance.rerender()`.
5. [unit] Calling the resize handler twice before the timeout fires calls `_renderChatDeps.clearTimeout` with the first timeout's handle, and firing the second timeout produces exactly one `instance.repaint()`.
6. [unit] Unmounting the returned instance calls the resize remover exactly once and calls `_renderChatDeps.clearTimeout` with a pending repaint timeout's handle; firing that timeout's callback afterwards neither writes `CLEAR_ALT_SCREEN` nor calls `instance.repaint()`.
7. [unit] Calling the resize handler after the returned instance was unmounted arms no timeout.
8. [unit] The default `_renderChatDeps.onResize(handler)` raises `process.stdout.listenerCount("resize")` by one, and calling its remover lowers it by one.
9. [unit] On a TTY mount, a busy report that armed the title-animation timeout followed by a resize does not pass the title timeout's handle to `_renderChatDeps.clearTimeout`.
10. [integration] The `repaint.mjs` fixture renders a three-row Ink component with `incrementalRendering: true` to a fake TTY stream, then calls `instance.repaint()` without changing the component; the bytes Ink wrote after that call contain each of the three rows' text.
11. [integration] In the same fixture, calling `instance.repaint()` after `instance.unmount()` writes no bytes.
12. [integration] In `resize.test.ts`, with tmux available, a chat pane at 80x24 whose turn is running is resized to 50 columns and then back to 80; once tmux reports the chat pane's width as 80 (`display-message -p '#{pane_width}'`), the chat pane's captured screen equals the unresized reference pane's screen.

### US-002

1. [unit] `formatDuration(0)` returns `"0s"`.
2. [unit] `formatDuration(59_999)` returns `"59s"`.
3. [unit] `formatDuration(60_000)` returns `"1m 00s"`.
4. [unit] `formatDuration(1_255_000)` returns `"20m 55s"`.
5. [unit] `formatDuration(3_599_999)` returns `"59m 59s"`.
6. [unit] `formatDuration(3_600_000)` returns `"1h 00m 00s"`.
7. [unit] `formatDuration(6_379_000)` returns `"1h 46m 19s"`.
8. [unit] `formatDuration(90_000_000)` returns `"25h 00m 00s"`.
9. [unit] `formatDuration(-5)` returns `"0s"`.
10. [unit] `formatDuration(Number.NaN)` returns `"0s"`.
11. [unit] `workingLine` for a thinking status whose `startedAt` is 6,379 seconds before `nowMs`, drawn with no width, returns spans whose joined text contains `(1h 46m 19s · `.
12. [unit] `workingLine` for the same status at width 40 returns spans whose joined text ends with `(1h 46m 19s)`.
13. [unit] `turnStatsText({ rate: 32.1, outputTokens: 36_000, elapsedMs: 5_229_000 })` returns `"32.1 tok/s · 36.0k out · 1h 27m 09s"`.
14. [unit] `turnStatsText({ rate: undefined, outputTokens: 1_300, elapsedMs: 14_000 })` returns `"1.3k out · 14s"`.
15. [unit] Laying out a finished thinking entry whose `endedAt` is 75 seconds after its `startedAt` produces a first row whose text contains `Thought for 1m 15s`.
16. [unit] A finished agent tool card with 3 children whose `endedAt` is 125 seconds after its `startedAt`, drawn collapsed, has a summary line that ends with `(3 tool uses · 2m 05s)`.

### US-003

1. [unit] `steeredTaskNoticeLine("1 background command ended · 1 succeeded")` returns `"1 background command ended · 1 succeeded · sent into the running turn"`.
2. [integration] With the chat screen mounted on a host whose `steer` returns `accepted` with an unsettled `applied`, a submitted user message still running, and a background task that then ends, `host.steer` is called once with the full text `tasks.peekNotice()` returns for that task.
3. [integration] With a host whose `steer` returns `accepted` with an unsettled `applied`, a running user turn and a background task that ends during it, resolving `applied` with `true` calls `tasks.takeNotice()` once and adds a transcript row reading `steeredTaskNoticeLine(summarizeBackgroundNotice(<that notice>))`.
4. [integration] With a host whose `steer` returns `accepted` with an unsettled `applied`, a running user turn and a background task that ends during it, after `applied` resolves `true` and the user turn finishes, `host.send` has been called only with the user's message.
5. [integration] With a host whose `steer` returns `accepted` with an unsettled `applied`, a running user turn and a background task that ends during it, further renders while `applied` is unsettled (a typed character, a status tick) do not call `host.steer` a second time.
6. [integration] With a host whose `steer` returns `unsupported`, a running user turn and a task that then ends, further renders do not call `host.steer` a second time, and after the turn finishes `host.send` is called a second time with the task notice.
7. [integration] With a host whose `steer` returns `accepted`, resolving `applied` with `false` while the user turn is still running and then finishing that turn calls `host.steer` exactly once, calls `host.send` a second time with the task notice, and adds no `sent into the running turn` row.
8. [integration] With a host whose `steer` returns `accepted` and an `applied` still unsettled when the user turn finishes, `host.send` is not called with the task notice until `applied` resolves `false`, after which it is, and no `auto-wake paused` row is added while it waits.
9. [integration] With a host whose `steer` returns `accepted` and an `applied` that never settles, a job notice queued after the user turn finishes is delivered with `host.send`.
10. [integration] With a host whose `steer` returns `no_turn`, a running user turn and a task that then ends, `host.steer` is called once, the notice stays queued, and after the turn finishes `host.send` is called with it.
11. [integration] With a host whose `steer` returns `accepted` and resolves `applied` with `true`, two tasks that end one after the other during one user turn produce two `host.steer` calls, the second with a notice naming the second task's id.
12. [integration] With `taskNoticeTurns` set to 1 and a steerable host, a task steered into a user turn does not count toward the guard: after that turn finishes, a task that ends while the chat is idle is delivered with `host.send`, and no `auto-wake paused` row is added.
13. [integration] With `taskNoticeTurns` set to 0, a host whose `steer` returns `accepted` and resolves `applied` with `true`, and a task that ends during a running user turn, `host.steer` is called with the notice and the `sent into the running turn` row is added.
14. [integration] With a host whose `steer` throws, a running user turn and a task that then ends, the screen stays mounted, `host.steer` is called once, the notice stays queued, and after the turn finishes `host.send` is called with it.
15. [integration] With a host whose `steer` returns `accepted` with an `applied` that rejects, `host.steer` is called exactly once, the notice stays queued, and after the turn finishes `host.send` is called with it.
16. [integration] A host with no `steer` keeps today's order: a task that ends during a running user turn is delivered with `host.send` only after that turn finishes.
17. [integration] With a host whose `steer` returns `accepted`, a background task that ends while the chat is idle is delivered with `host.send` once, `host.steer` is not called while that notice turn runs, and `tasks.takeNotice()` is called once.
