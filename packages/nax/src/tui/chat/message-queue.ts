/**
 * The chat screen's message queue: the lines the user typed while a turn was running, held
 * until it finishes.
 *
 * A busy prompt used to drop a plain return, so a thought had to be held in the user's head
 * until the turn ended. Now the line goes here instead, and the screen submits one queued
 * message per completed turn through exactly the path a typed return takes — so a queued
 * line expands its mentions, earns its own user row and becomes the session's title just
 * like a typed one.
 *
 * Everything here is a pure function over a readonly list: the screen replaces the queue it
 * holds (a new array per push) rather than editing it, so a React state update can compare by
 * reference and an in-flight render keeps the queue it drew. A message that has to go back
 * into the prompt is joined by `queueToPrompt`, oldest first, above whatever the user has
 * typed since — the order they would have sent the lines in.
 *
 * The rows the queue claims on screen are `queueRowLines`' business, not the screen's: the
 * cap, the muted `queued · <text>` marker and the `+N more` overflow exist in one place, so
 * the drawn rows and the height the bottom region reserves for them cannot disagree.
 */
import { oneLine } from "./layout-lines";
import { sanitizeText } from "./styled-line";

/** The lines waiting for the running turn to finish, oldest first. */
export type MessageQueue = readonly string[];

/** The most queued messages drawn at once; anything longer is counted by a `+N more` row. */
export const MAX_QUEUED_ROWS = 3;

/** What a queued message's row says in front of the text: muted, one row per message. */
const QUEUED_MARKER = "queued · ";

/** The row that stands for the messages the cap hides: `+2 more`. */
const MORE_PREFIX = "+";
const MORE_SUFFIX = " more";

/** The queue with `text` appended: the line waits behind everything queued before it. */
export function pushQueued(queue: MessageQueue, text: string): MessageQueue {
  return [...queue, text];
}

/**
 * The queue with `text` ahead of everything already in it — where a message that turned out
 * not to reach the running turn goes, so it is sent before the ones that were queued earlier.
 */
export function pushQueuedFront(queue: MessageQueue, text: string): MessageQueue {
  return [text, ...queue];
}

/**
 * The oldest queued message and the queue without it, or `undefined` for an empty queue.
 * A turn takes exactly one message, so the two halves are returned together: there is no
 * state in which the message is sent and the queue still holds it.
 */
export function takeQueued(queue: MessageQueue): { readonly text: string; readonly rest: MessageQueue } | undefined {
  const [text, ...rest] = queue;
  return text === undefined ? undefined : { text, rest };
}

/**
 * What the prompt holds once the queue has to go back into it: every queued text, oldest
 * first, above the draft the user has typed since. An empty draft adds no line of its own,
 * so a queue restored into an untouched prompt leaves no blank row for the user to delete.
 */
export function queueToPrompt(queue: MessageQueue, draft: string): string {
  return [...queue, draft].filter((line) => line !== "").join("\n");
}

/**
 * The rows the queue draws above the input, oldest first: one muted `queued · <text>` row
 * per message up to `MAX_QUEUED_ROWS`, then a single `+N more` row when the queue is longer.
 * The count is the height the screen reserves, so the drawn rows and the reserved rows are
 * the same number.
 *
 * Each message is one row: a queued line that carries a newline (an alt+enter draft) is
 * flattened, and a line carrying terminal escapes is stripped, so nothing a user queued can
 * take more rows than it was counted for or draw over the screen.
 */
export function queueRowLines(queue: MessageQueue): readonly string[] {
  const shown = queue.slice(0, MAX_QUEUED_ROWS).map((text) => `${QUEUED_MARKER}${oneLine(sanitizeText(text))}`);
  const hidden = queue.length - shown.length;
  return hidden > 0 ? [...shown, `${MORE_PREFIX}${hidden}${MORE_SUFFIX}`] : shown;
}
