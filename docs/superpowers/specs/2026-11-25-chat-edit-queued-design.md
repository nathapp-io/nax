# nax chat: edit queued messages (up recalls the queue) - design

Date: 2026-11-25. Status: approved in conversation. Size: small change.

## Intent

While a turn runs, a plain return queues the line (`queued · <text>` rows above the input). Today a
queued line cannot be changed: the user has to wait for it to be sent, or interrupt the turn.
The user wants Claude Code's behaviour: press up to pull the queued messages back into the prompt
and edit them.

## Goals

- Bare up, with an empty prompt and a non-empty queue, moves every queued message into the prompt
  (oldest first, one line each) and empties the queue.
- The recalled text is an ordinary draft: return queues it again (as one message) while the turn
  still runs, or sends it if the turn has ended; clearing it drops it.
- The footer and `/help` tell the user the key exists.

## Non-goals

- Editing, removing or reordering a single queued item in place; a queue picker.
- Recalling a steer the brain already accepted (it is in the session's steer channel), or the
  pending interrupt-send.
- Queues in other front ends: the queue is TUI-only (`packages/nax/src/tui/chat/message-queue.ts`).
- Persisting the queue across a restart or session switch.

## Anti-goals

- A drain that sends a line the user is editing. Emptying the queue at the keypress (through
  `replaceQueue`, which writes `queueRef` ahead of React) is what rules this out.
- Up no longer browsing history: with an empty queue, or a non-empty prompt, up behaves exactly as
  today.

## Approaches

1. **Recall all into the prompt (picked).** Mirrors Claude Code; reuses the restore path a failed
   turn already takes (`replaceQueue(EMPTY_QUEUE)` + `restorePrompt(queueToPrompt(...))`,
   `ChatApp.tsx` `drainQueue`). Trade-off: separate queued lines come back as one draft and are
   re-queued as one message.
2. Recall the newest line only, one per press. Keeps message boundaries, but differs from what the
   user already knows and needs new take-newest logic.
3. In-place edit mode with a picker. Most keys and code, and needs a drain lock, for a queue that
   is usually 1-3 lines.

## Decided

- Trigger: bare up (no shift), slash menu not open, prompt text exactly empty, queue non-empty.
  Checked before history browsing; otherwise history browsing is unchanged.
- The input offers the key to its owner through a new optional `ChatInput` callback (same shape as
  `onQueue`: returns `true` when it took the key). Without the callback the input behaves as today.
- The screen reads `queueRef.current`, not the rendered queue.
- Footer `queued` hint extra becomes `up to edit queued · ctrl+s to send now`; `/help` gains a line
  for it.
- `.nax/features/chat-steer-and-polish/spec.md` is a historical record; the new feature spec states
  that it supersedes that spec's "cannot be edited" out-of-scope line.

## Left to the builder

- Exact callback name and where the check sits in the `ChatInput` key handler.
- Test placement, following the existing `message-queue.test.ts`, `chat-status-queued.test.ts` and
  `test/ui/chat/chat-app.test.tsx` patterns.
