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
 */
import { AgentSessionError } from "./agent-session-errors.ts";
import type { SessionEvent } from "./agent-session-types.ts";

type DeltaEvent = Extract<SessionEvent, { readonly type: "text_delta" | "thinking_delta" }>;

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

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

function isDelta(event: SessionEvent | undefined): event is DeltaEvent {
  return event !== undefined && (event.type === "text_delta" || event.type === "thinking_delta");
}

function canMergeInto(into: DeltaEvent, next: DeltaEvent): boolean {
  return into.type === next.type && into.round === next.round;
}

export function createSessionEventChannel(options: SessionEventChannelOptions): SessionEventChannel {
  let queue: SessionEvent[] = [];
  let head = 0;
  let tail: DeltaEvent | undefined;
  let waiter: ((result: IteratorResult<SessionEvent>) => void) | undefined;
  let undeliveredControl = 0;
  let ended = false;
  let consumerGone = false;
  let pulled = false;
  let stalled = false;

  function deliver(result: IteratorResult<SessionEvent>): boolean {
    if (waiter === undefined) return false;
    const resolve = waiter;
    waiter = undefined;
    resolve(result);
    return true;
  }

  /** Drop the consumed prefix; O(1) when the buffer is fully drained. */
  function compact(): void {
    if (head > 0 && head === queue.length) {
      queue = [];
      head = 0;
    }
  }

  function enqueue(event: SessionEvent): void {
    if (isDelta(event)) {
      if (tail !== undefined && canMergeInto(tail, event)) {
        // Replace, don't mutate: DeltaEvent.text is readonly. O(1) — a
        // string concat, not a buffer copy.
        tail = { ...tail, text: tail.text + event.text };
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
    if (head < queue.length) {
      const event = queue[head++];
      compact();
      if (!isDelta(event)) undeliveredControl -= 1;
      return { value: event, done: false };
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

  return { push, end, iterator: { next, return: leave } };
}
