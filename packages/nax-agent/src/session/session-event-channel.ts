/**
 * The push-to-pull channel behind send()'s iterator (spec 4.4). The turn
 * pushes; one consumer pulls. While the consumer lags, adjacent deltas of the
 * same type and round merge. Control events are never merged or dropped; past
 * `controlCap` undelivered ones the channel reports a stall, once. One
 * consumer only: a second next() while one is pending rejects (for await
 * never makes one). return() before the first next() never starts the turn.
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

function asDelta(event: SessionEvent | undefined): DeltaEvent | undefined {
  return event !== undefined && (event.type === "text_delta" || event.type === "thinking_delta") ? event : undefined;
}

function merged(last: DeltaEvent | undefined, next: DeltaEvent | undefined): DeltaEvent | undefined {
  if (last === undefined || next === undefined) return undefined;
  if (last.type !== next.type || last.round !== next.round) return undefined;
  return { ...last, text: last.text + next.text };
}

export function createSessionEventChannel(options: SessionEventChannelOptions): SessionEventChannel {
  let buffer: readonly SessionEvent[] = [];
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

  function enqueue(event: SessionEvent): void {
    const combined = merged(asDelta(buffer[buffer.length - 1]), asDelta(event));
    if (combined !== undefined) {
      buffer = [...buffer.slice(0, -1), combined];
      return;
    }
    buffer = [...buffer, event];
    if (asDelta(event) !== undefined) return;
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
    if (buffer.length === 0) deliver(DONE);
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
    const [head, ...rest] = buffer;
    if (head !== undefined) {
      buffer = rest;
      if (asDelta(head) === undefined) undeliveredControl -= 1;
      return { value: head, done: false };
    }
    if (ended) return DONE;
    return new Promise((resolve) => {
      waiter = resolve;
    });
  }

  async function leave(): Promise<IteratorResult<SessionEvent>> {
    if (consumerGone) return DONE;
    consumerGone = true;
    buffer = [];
    deliver(DONE);
    if (!ended) options.onReturn();
    return DONE;
  }

  return { push, end, iterator: { next, return: leave } };
}
