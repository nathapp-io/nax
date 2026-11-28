/**
 * The push-to-pull channel behind send()'s iterator (spec 4.4). The turn
 * pushes; one consumer pulls. While the consumer lags, adjacent deltas of the
 * same type and round merge. Control events are never merged or dropped; past
 * `controlCap` undelivered ones the channel reports a stall, once. One
 * consumer only: a second next() while one is pending rejects (for await
 * never makes one). return() before the first next() never starts the turn.
 *
 * The buffer is two slots: a `queue` of non-mergeable events (FIFO, indexed)
 * and a `tail` that is always a delta the next push can merge into. push is
 * amortized O(1) — a `queue.push` and the `tail` swap are O(1), and the
 * merge's string concat is O(merged-text length), which is the same cost the
 * old design paid, just without the per-merge buffer copy. The pop is a
 * `queue[head++]` read, not an `Array.shift()`. The old implementation
 * copied the whole buffer on every merge (`[...buffer.slice(0, -1), combined]`),
 * which made a high-rate delta stream quadratic.
 *
 * Reclamation: a pull clears its slot's reference immediately, and a pass
 * relocates the undelivered suffix to the front as soon as the consumed prefix
 * is no longer shorter than it (the whole array is dropped once it is fully
 * consumed). So the span — consumed slots, pending FIFO slots and the tail —
 * is `head + pending` with `head === 0` or `head < pending-in-FIFO`, i.e.
 * strictly below twice the pending backlog. For the two-event sustained-backlog
 * fixture the span stays at exactly 2, so the stated slack over that backlog is
 * one spare slot. Work stays amortized O(1): a pass moves at most as many slots
 * as it drops, so draining N events relocates fewer than N in total (8,178 to
 * drain 8,192) — never a whole-queue shift per pull.
 */
import { AgentSessionError } from "./agent-session-errors.ts";
import type { SessionEvent } from "./agent-session-types.ts";

type DeltaEvent = Extract<SessionEvent, { readonly type: "text_delta" | "thinking_delta" | "tool_input_delta" }>;

export interface SessionEventChannelOptions {
  /** Undelivered control events tolerated before onStall fires. */
  readonly controlCap: number;
  /** The consumer's first next(): the turn starts here. May push synchronously. */
  readonly onFirstPull: () => void;
  /** The consumer called return() before the channel ended. */
  readonly onReturn: () => void;
  readonly onStall: () => void;
}

export interface SessionEventChannel {
  push(event: SessionEvent): void;
  /** No more events: the iterator completes once the buffer drains. */
  end(): void;
  readonly iterator: AsyncIterator<SessionEvent>;
}

/**
 * The channel's real backing storage, as the channel itself holds it. Not part
 * of `SessionEventChannel`, not re-exported from either package entry, and read
 * only by this module's suite: a test must be able to see which event objects
 * the FIFO actually retains and how many slots reclamation actually moved,
 * rather than a derived `length - head` counter that stays small while
 * delivered references pile up behind it.
 */
export interface SessionEventChannelStorage {
  /** Every event object the backing storage still references: all occupied slots, then the tail. */
  readonly referenced: readonly SessionEvent[];
  /** The undelivered events, FIFO order, the mergeable tail last. */
  readonly pending: readonly SessionEvent[];
  /** Backing slots in use: the consumed prefix, the pending FIFO slots and the tail slot. */
  readonly span: number;
  /** Undelivered slots moved by reclamation passes since creation. */
  readonly relocatedSlots: number;
}

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

/** Package-private: maps a channel to its storage reader. Test-only. */
const storageReaders = new WeakMap<SessionEventChannel, () => SessionEventChannelStorage>();

function isDelta(event: SessionEvent | undefined): event is DeltaEvent {
  return (
    event !== undefined &&
    (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_input_delta")
  );
}

function canMergeInto(into: DeltaEvent, next: DeltaEvent): boolean {
  if (into.type !== next.type || into.round !== next.round) return false;
  if (into.type === "tool_input_delta" && next.type === "tool_input_delta") return into.callId === next.callId;
  return true;
}

function mergeDeltas(into: DeltaEvent, next: DeltaEvent): DeltaEvent {
  if (into.type === "tool_input_delta" && next.type === "tool_input_delta") {
    return { ...into, chars: into.chars + next.chars };
  }
  if (into.type !== "tool_input_delta" && next.type !== "tool_input_delta") {
    return { ...into, text: into.text + next.text };
  }
  return into;
}

export function createSessionEventChannel(options: SessionEventChannelOptions): SessionEventChannel {
  let queue: (SessionEvent | undefined)[] = [];
  let head = 0;
  let tail: DeltaEvent | undefined;
  let waiter: ((result: IteratorResult<SessionEvent>) => void) | undefined;
  let undeliveredControl = 0;
  let ended = false;
  let consumerGone = false;
  let pulled = false;
  let stalled = false;
  /** Undelivered slots reclamation has moved since creation. */
  let relocatedSlots = 0;

  function deliver(result: IteratorResult<SessionEvent>): boolean {
    if (waiter === undefined) return false;
    const resolve = waiter;
    waiter = undefined;
    resolve(result);
    return true;
  }

  /**
   * Release the consumed prefix. Dropping the array when it is fully consumed
   * is O(1); otherwise a pass runs only once the consumed prefix is at least as
   * long as the pending suffix, so it relocates no more slots than it drops.
   */
  function reclaim(): void {
    if (head === 0) return;
    if (head === queue.length) {
      // Fully drained: the whole array, consumed slots included, is released.
      queue = [];
      head = 0;
      return;
    }
    const pendingCount = queue.length - head;
    if (head < pendingCount) return;
    queue = queue.slice(head);
    relocatedSlots += pendingCount;
    head = 0;
  }

  /**
   * Take the first FIFO event, releasing its reference before it is handed
   * over: several deliveries can pass before a reclamation pass would.
   */
  function takePending(): SessionEvent | undefined {
    if (head >= queue.length) return undefined;
    const event = queue[head];
    queue[head] = undefined;
    head += 1;
    reclaim();
    return event;
  }

  function enqueue(event: SessionEvent): void {
    if (isDelta(event)) {
      if (tail !== undefined && canMergeInto(tail, event)) {
        // Replace, don't mutate: DeltaEvent.text is readonly. O(1) — a
        // string concat, not a buffer copy.
        tail = mergeDeltas(tail, event);
        return;
      }
      if (tail !== undefined) queue.push(tail);
      tail = event;
      return;
    }
    // Control events: never held in `tail` (so a later delta sees no merge
    // partner and the cap math stays correct).
    if (tail !== undefined) {
      queue.push(tail);
      tail = undefined;
    }
    queue.push(event);
    undeliveredControl += 1;
    if (!stalled && undeliveredControl > options.controlCap) {
      stalled = true;
      options.onStall();
    }
  }

  function push(event: SessionEvent): void {
    if (ended || consumerGone) return;
    if (deliver({ value: event, done: false })) return;
    enqueue(event);
  }

  function end(): void {
    if (ended) return;
    ended = true;
    if (queue.length === head && tail === undefined) deliver(DONE);
  }

  async function next(): Promise<IteratorResult<SessionEvent>> {
    if (consumerGone) return DONE;
    if (waiter !== undefined) {
      throw new AgentSessionError("send() iterables support one next() at a time", "AGENT_SESSION_BUSY");
    }
    if (!pulled) {
      pulled = true;
      options.onFirstPull();
    }
    const buffered = takePending();
    if (buffered !== undefined) {
      if (!isDelta(buffered)) undeliveredControl -= 1;
      return { value: buffered, done: false };
    }
    if (tail !== undefined) {
      const event = tail;
      tail = undefined;
      return { value: event, done: false };
    }
    if (ended) return DONE;
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }

  async function leave(): Promise<IteratorResult<SessionEvent>> {
    if (consumerGone) return DONE;
    consumerGone = true;
    queue = [];
    head = 0;
    tail = undefined;
    deliver(DONE);
    if (!ended) options.onReturn();
    return DONE;
  }

  /** The real backing storage, for `inspectSessionEventChannel`. */
  function readStorage(): SessionEventChannelStorage {
    const referenced: SessionEvent[] = [];
    for (const event of queue) {
      if (event !== undefined) referenced.push(event);
    }
    // Slots at or after `head` are pending, never released, so this is the
    // undelivered FIFO; the tail is the last undelivered event.
    const pending: SessionEvent[] = [];
    for (let index = head; index < queue.length; index += 1) {
      const event = queue[index];
      if (event !== undefined) pending.push(event);
    }
    if (tail !== undefined) {
      referenced.push(tail);
      pending.push(tail);
    }
    return { referenced, pending, span: queue.length + (tail === undefined ? 0 : 1), relocatedSlots };
  }

  const channel: SessionEventChannel = { push, end, iterator: { next, return: leave } };
  storageReaders.set(channel, readStorage);
  return channel;
}

/**
 * Read a channel's real backing storage. Package-private and test-only: it is
 * not part of the channel contract, nothing in `src/` calls it, and no package
 * entry re-exports it.
 */
export function inspectSessionEventChannel(channel: SessionEventChannel): SessionEventChannelStorage {
  const read = storageReaders.get(channel);
  if (read === undefined) {
    throw new AgentSessionError("Channel was not created by createSessionEventChannel", "AGENT_SESSION_INVALID_INPUT");
  }
  return read();
}
