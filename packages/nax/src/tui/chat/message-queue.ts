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
 * `pendingPreviewLines` is that arithmetic for a short terminal: the pending steers and the
 * queue share one row budget, and the row that names what did not fit counts both groups.
 */
import { oneLine, resolveWidth } from "./layout-lines";
import { sanitizeText } from "./styled-line";
import { cutSpans } from "./wrap";

/** The lines waiting for the running turn to finish, oldest first. */
export type MessageQueue = readonly string[];

/** The most queued messages drawn at once; anything longer is counted by a `+N more` row. */
export const MAX_QUEUED_ROWS = 3;

/**
 * The most combined preview rows the screen draws: the pending steers and the queued messages
 * share one budget, because two separate caps still overflow a short terminal.
 */
export const MAX_PENDING_PREVIEW_ROWS = 4;

/** What a queued message's row says in front of the text: muted, one row per message. */
const QUEUED_MARKER = "queued · ";

/** What a steer waiting on the running turn says in front of its text: muted, like a queued row. */
const STEERING_MARKER = "steering · ";

/** The row that stands for the messages the cap hides: `+2 more`. */
const MORE_PREFIX = "+";
const MORE_SUFFIX = " more";
/** The row that stands for the pending items a preview budget hides: `+3 pending`. */
const PENDING_SUFFIX = " pending";

/** The queue with `text` appended: the line waits behind everything queued before it. */
export function pushQueued(queue: MessageQueue, text: string): MessageQueue {
  return [...queue, text];
}

/**
 * The queue with `text` ahead of everything already in it — ahead of anything queued earlier,
 * which is where a message that turned out not to reach the running turn belongs. One message
 * at a time; several that a single turn discarded go through `pushDiscardedSteer`, which keeps
 * them in the order they were steered instead of reversing them.
 */
export function pushQueuedFront(queue: MessageQueue, text: string): MessageQueue {
  return [text, ...queue];
}

/**
 * The steers one turn discarded, in the order they were steered: the leading group of the
 * queue. A turn that ends with several steers pending resolves them together, one callback
 * each, and each one belongs ahead of everything queued earlier — but prepending them one at
 * a time would draw the last steer first and reverse the corrections relative to the
 * instructions they correct. So they are kept as one group instead.
 *
 * A group belongs to the turn that discarded it, so the screen starts each send with no group
 * at all: a line a later turn discards is ahead of the queue that turn inherited, not appended
 * behind the group of the turn before it.
 */
export interface DiscardedSteers {
  readonly texts: readonly string[];
}

/** Whether `queue` still begins with the group's texts — false once the group left the queue. */
function leadsWith(queue: MessageQueue, texts: readonly string[]): boolean {
  return texts.length <= queue.length && texts.every((text, index) => queue[index] === text);
}

/**
 * Put one discarded steer at the front of `queue`, keeping the discarded group in the order
 * the user steered it: the new text joins the group (appended, because a turn settles its
 * pending steers in arrival order) and the group is drawn ahead of everything behind it —
 * including a line the user queued since the first discard, which stays where it was. A group
 * the queue no longer begins with has left it — drained, restored into the prompt, or
 * replaced — so this text starts a new one.
 */
export function pushDiscardedSteer(
  group: DiscardedSteers | undefined,
  queue: MessageQueue,
  text: string,
): { readonly group: DiscardedSteers; readonly queue: MessageQueue } {
  const leading = group !== undefined && leadsWith(queue, group.texts) ? group.texts : [];
  const texts = [...leading, text];
  return { group: { texts }, queue: [...texts, ...queue.slice(leading.length)] };
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
  const shown = queue.slice(0, MAX_QUEUED_ROWS).map(queuedRow);
  const hidden = queue.length - shown.length;
  return hidden > 0 ? [...shown, `${MORE_PREFIX}${hidden}${MORE_SUFFIX}`] : shown;
}

/** One queued message's row: its label, then its text flattened and stripped to a single row. */
function queuedRow(text: string): string {
  return `${QUEUED_MARKER}${oneLine(sanitizeText(text))}`;
}

/** One pending steer's row, drawn exactly like a queued row but for its label. */
function steeredRow(row: SteeringRow): string {
  return `${STEERING_MARKER}${oneLine(sanitizeText(row.text))}`;
}

/**
 * One steer the running turn has not taken yet: the text the user handed it, and the id its
 * `applied` promise is settled by (US-004). The screen drops the row by id, so two steers in
 * flight are two rows that resolve independently.
 */
export interface SteeringRow {
  readonly steerId: string;
  readonly text: string;
}

/**
 * The rows the pending steers draw above the queue, in arrival order: one muted
 * `steering · <text>` row each. Like a queue row, each text is flattened to one row and
 * stripped of terminal escapes, so a steer can take no more rows than it was counted for.
 */
export function steeringRowLines(steering: readonly SteeringRow[]): readonly string[] {
  return steering.map(steeredRow);
}

/** What a combined pending projection is drawn from: both groups, and the rows it may use. */
export interface PendingPreviewInput {
  /** The steers the running turn has not taken yet, in arrival order. */
  readonly steering?: readonly SteeringRow[];
  /** The messages waiting for the next turn, oldest first. */
  readonly queued?: MessageQueue;
  /**
   * The rows the frame allocated to the previews. Absent means the normal maximum; a smaller
   * number is a short terminal's budget, and zero draws nothing at all.
   */
  readonly budget?: number;
  /**
   * The columns each row is drawn into. A row longer than them is cut, because a preview is
   * one physical row: an over-long one would wrap into a second row nobody allocated.
   */
  readonly columns?: number;
}

/**
 * The pending previews as one height-bounded projection: the steers in arrival order and then
 * the queued messages oldest first, in at most `budget` rows — four by default. When every
 * pending item fits, every one of them is drawn. Otherwise the last available row stands for
 * the rest as `+N pending`, where N counts the items hidden across **both** groups, so the
 * summary is inside the budget rather than beside it.
 *
 * This is a projection and nothing more: the queue it reads, the steering rows it reads and
 * everything they hold are left exactly as they were. A hidden message is still queued, a
 * hidden steer is still pending, and a resize that finds more room shows them again.
 */
export function pendingPreviewLines(input: PendingPreviewInput): readonly string[] {
  const budget = previewBudget(input.budget);
  if (budget === 0) return [];
  const items = [...(input.steering ?? []).map(steeredRow), ...(input.queued ?? []).map(queuedRow)];
  if (items.length === 0) return [];
  const shown = items.length <= budget ? items : overflowed(items, budget);
  return shown.map((row) => fittedRow(row, input.columns));
}

/** The budget a projection may use: the allocation's rows, never past the normal maximum. */
function previewBudget(budget: number | undefined): number {
  if (budget === undefined || !Number.isFinite(budget)) return MAX_PENDING_PREVIEW_ROWS;
  return Math.max(0, Math.min(MAX_PENDING_PREVIEW_ROWS, Math.floor(budget)));
}

/** The rows a projection draws when the pending items do not fit: what fits, then the count. */
function overflowed(items: readonly string[], budget: number): readonly string[] {
  const shown = items.slice(0, budget - 1);
  return [...shown, `${MORE_PREFIX}${items.length - shown.length}${PENDING_SUFFIX}`];
}

/** One projection row, cut to the columns it is drawn into so it stays one physical row. */
function fittedRow(row: string, columns: number | undefined): string {
  if (columns === undefined) return row;
  return cutSpans([{ text: row }], resolveWidth(columns))
    .map((span) => span.text)
    .join("");
}
