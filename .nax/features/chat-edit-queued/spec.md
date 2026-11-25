# SPEC: nax chat - up recalls the queued messages for editing

## Summary

While a turn runs in `nax chat`, a plain return queues the typed line, drawn as a muted
`queued · <text>` row above the input. Today a queued line cannot be changed. This feature
makes a bare up arrow, pressed with an empty prompt while the queue holds messages, move every
queued message back into the prompt (oldest first, one line each) and empty the queue, the way
Claude Code does. The recalled text is an ordinary draft: return queues it again as one message
while the turn still runs, or sends it once the turn has ended. The footer and `/help` name the
key. With an empty queue, or a prompt that holds text, up browses history exactly as today.

## Motivation

A queued line is fixed once queued: the only ways to change it are to wait for it to be sent or
to interrupt the turn with escape. A user who notices a typo, or changes their mind while the
agent works, has no way to correct the follow-up before it goes. The queue lives only in the chat
TUI (`packages/nax/src/tui/chat/message-queue.ts`, state in `ChatApp.tsx`), and the restore path
that puts the queue back into the prompt already exists for a turn that fails; this feature lets
the user take that path on purpose.

The earlier feature spec `.nax/features/chat-steer-and-polish/spec.md` listed "cannot be edited or
reordered in place" as out of scope. This spec supersedes that line for recall-and-edit only;
in-place reordering stays out of scope.

## Design

### Integration

Read-only symbols (verified on `main` at `61fd429af`):

- `packages/nax/src/tui/chat/message-queue.ts`:
  - `type MessageQueue = readonly string[]`, oldest first.
  - `queueToPrompt(queue: MessageQueue, draft: string): string` joins the queued texts and the
    draft with `\n`, dropping empty strings.
- `packages/nax/src/tui/chat/ChatApp.tsx`:
  - `queueRef: React.MutableRefObject<MessageQueue>` is the queue ahead of React; the drain reads
    it after `await`s.
  - `replaceQueue(next: MessageQueue): void` writes `queueRef.current` and `setQueued` together.
  - `EMPTY_QUEUE` is the empty queue constant.
  - `queueReturn(text: string): boolean` is passed to `ChatInput` as `onQueue`: an owner callback
    the input runs inside its key handler, the precedent the new callback follows.
  - `drainQueue(outcome)` already restores the queue into the prompt on a non-completed turn with
    `replaceQueue(EMPTY_QUEUE)` then `restorePrompt(queueToPrompt(queue, editorRef.current.text))`.
- `packages/nax/src/tui/chat/ChatInput.tsx`:
  - `historyDirection(key: Key): "previous" | "next" | undefined` returns `"previous"` for an
    unshifted up arrow.
  - In the `useInput` handler, `ownsNavigation(key) && yieldsNavigation()` returns early when the
    slash menu owns the key, before escape handling and before `historyDirection`.
  - `atEnd(text: string): EditorState` is an editor holding `text` with the cursor at its end.
  - `publish(next)` writes the draft (editor plus history).

Symbols this feature changes. The baseline only locates the code; implement the target.

- `ChatInputProps` (`ChatInput.tsx`)
  - Baseline: has optional `onQueue?: (text: string) => boolean` and `busyNow?: () => boolean`;
    no recall callback.
  - Target: gains optional `onRecallQueued?: () => string | undefined`. The input calls it when a
    key yields `historyDirection(key) === "previous"`, the slash menu does not own the key, and
    the current editor text is exactly `""`. A returned string is written into the prompt with
    `atEnd(text)` (history unchanged, history browsing not started) and the key is consumed. A
    returned `undefined`, or no callback, falls through to today's history browsing. The owner
    must not throw.
- `ChatApp` (`ChatApp.tsx`)
  - Baseline: passes `onQueue={queueReturn}` and no recall callback.
  - Target: passes `onRecallQueued={recallQueued}`, where `recallQueued()` reads
    `queueRef.current`; for an empty queue it returns `undefined`; otherwise it calls
    `replaceQueue(EMPTY_QUEUE)` and returns `queueToPrompt(queue, "")`.
- `HINT_PARTS.queued` (`packages/nax/src/tui/chat/chat-status.ts`)
  - Baseline: `{ gesture: "esc to interrupt", extra: "ctrl+s to send queued now" }`.
  - Target: `{ gesture: "esc to interrupt", extra: "up to edit queued · ctrl+s to send now" }`.
- `CHAT_KEYBOARD_HELP` (`packages/nax/src/tui/chat/help-text.ts`)
  - Baseline: ends with `"ctrl+s  steer the running turn (or interrupt and send)"`.
  - Target: the same rows followed by one new last row
    `"up  edit queued messages (empty prompt)"`.

### Approach

Recall all queued messages into the prompt at once (Claude Code's behaviour), reusing
`queueToPrompt` and `replaceQueue`. Emptying the queue at the keypress, through `queueRef`, is
what keeps a drain from sending a line the user is editing: once recalled, the text is in the
prompt and nowhere else. Rejected: recalling only the newest line per press (keeps message
boundaries but differs from the behaviour the user expects) and an in-place picker (needs a drain
lock for a queue of one to three lines).

Interactions with existing state, all unchanged by this feature:

- A pending interrupt-send (`interruptSend`) is not in the queue and is not recalled.
- Pending steers (the `steering · <text>` rows) are not in the queue and are not recalled.
- The discarded-steer group (`discardedSteers`) needs no reset: `pushDiscardedSteer` already
  starts a new group when the queue no longer begins with the old one.
- A recalled draft returned while a turn still runs goes through `onQueue` as one queued message;
  returned once no turn runs, it is submitted as a typed return.

### Failure Handling

| Case | Behaviour |
|:---|:---|
| Up with an empty queue and an empty prompt | `recallQueued` returns `undefined`; history browsing runs as today |
| Up with text in the prompt | The callback is not called; history browsing runs as today |
| Up while the slash menu owns the key | The menu keeps the key; the callback is not called |
| Shift+up | Not a history key; the callback is not called and the viewport scrolls as today |
| A drain fires after the recall | The queue is already empty, so nothing is sent and the prompt is untouched |

## Out of Scope

- Editing, removing or reordering one queued message in place, or a picker over the queue.
- Recalling a steer the brain already accepted, or the pending interrupt-send, into the prompt.
- Keeping queued messages as separate messages after recall: a recalled draft is re-queued or sent as one message.
- Message queues in any front end other than the `nax chat` TUI; the queue does not exist outside `packages/nax/src/tui/chat`.
- Persisting the queue across a restart or a session switch.
- Image attachments: a picture travels as a placeholder in the prompt text, so an empty prompt carries none and the recall touches no attachment state.
- Editing `.nax/features/chat-steer-and-polish/spec.md`: it is a historical record of a shipped feature.

## Stories

**US-001: Up recalls the queued messages into the prompt.** No dependencies. Workdir: `packages/nax`.
Add `onRecallQueued` to `ChatInput`, wire `recallQueued` in `ChatApp`, and update the footer
`queued` hint and `/help` keyboard text as described in Design.

### Context Files

**US-001**
- `packages/nax/src/tui/chat/message-queue.ts` — `MessageQueue`, `queueToPrompt`.
- `packages/nax/src/tui/chat/ChatApp.tsx` — `queueRef`, `replaceQueue`, `queueReturn`, `drainQueue`, the `ChatInput` props.
- `packages/nax/src/tui/chat/ChatInput.tsx` — `ChatInputProps`, `historyDirection`, the `useInput` handler.
- `packages/nax/src/tui/chat/chat-status.ts` — `HINT_PARTS`.
- `packages/nax/test/ui/chat/chat-steer-queued.test.tsx` — the existing queue UI tests and their mount helpers.

### Modifies

**US-001**
- `packages/nax/test/unit/tui/chat/chat-status-queued.test.ts` — "AC-13 names the interrupt as its gesture and ctrl+s as its extra" asserts the queued hint's extra is `ctrl+s to send queued now`; it becomes `up to edit queued · ctrl+s to send now`, gesture unchanged.
- `packages/nax/test/ui/chat/chat-steer-queued.test.tsx` — `QUEUED_GESTURE` pins `ctrl+s to send queued now` for "AC-14 offers ctrl+s to send queued now on the footer row"; it becomes `up to edit queued · ctrl+s to send now`, and the test still asserts the footer row shows it while a line is queued at the helper's default terminal width (the title may be renamed to match).
- `packages/nax/test/unit/tui/chat/help-text.test.ts` — `TARGET_KEYBOARD_HELP` pins the exact keyboard help rows; it gains the new last row `up  edit queued messages (empty prompt)` after the ctrl+s row, and the count assertions in "AC-1 is the nine-line block the spec fixes, joined with newlines" and "names the nine rows the block has, Keyboard first" (`toHaveLength(9)`) become ten rows; the test titles say ten.

### Seams

None: the one new symbol (`onRecallQueued`) is produced and consumed inside US-001, and AC-1
exercises it from the chat screen.

## Acceptance Criteria

**US-001**

1. [integration] In the chat screen with a turn running, after `first` and `second` are queued with return, pressing up on the empty prompt makes the prompt hold `first\nsecond`: two prompt rows, `first` above `second` (the test reads every prompt row, not only the last `>` row).
2. [integration] In the same state, after pressing up, the screen draws no `queued ·` row.
3. [integration] After recalling `first` and `second` with up while the turn still runs, pressing return draws exactly one `queued ·` row, and when the turn ends `completed` the host's `send` receives the text `first\nsecond` as one message.
4. [integration] After recalling `first` with up while the turn runs, when the running turn ends `completed` the host's `send` is not called with `first` until the user presses return.
5. [integration] After recalling `first` with up while the turn runs, when the running turn ends `cancelled` the prompt still holds exactly `first`, not `first` twice.
6. [integration] With a turn running, `first` queued and `draft` typed in the prompt, pressing up does not put `first` into the prompt and the `queued · first` row stays drawn.
7. [integration] With nothing queued, an empty prompt and `earlier` in the input history, pressing up puts `earlier` in the prompt, as before this feature.
8. [integration] With a turn running and `first` queued, pressing shift+up leaves the prompt empty and the `queued · first` row drawn.
9. [unit] `ChatInput` rendered with an `onRecallQueued` callback returning `recalled`, given an up arrow on an empty prompt, shows `recalled` with the cursor at its end and calls the callback once.
10. [unit] `ChatInput` rendered with an `onRecallQueued` callback returning `undefined` and `earlier` in its history, given an up arrow on an empty prompt, shows `earlier`.
11. [unit] `ChatInput` rendered with an `onRecallQueued` callback and the text `abc` in the prompt, given an up arrow, does not call the callback.
12. [unit] `hintSpans("queued")` returns the gesture `esc to interrupt` and the extra `up to edit queued · ctrl+s to send now`.
13. [unit] The last row of `CHAT_KEYBOARD_HELP` is `up  edit queued messages (empty prompt)`.
