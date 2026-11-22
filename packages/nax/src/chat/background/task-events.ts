/**
 * A bounded record of one subagent run's session events, kept per background task so the chat
 * can draw the run's whole conversation (the full-screen agent view).
 *
 * Only the events a transcript is built from are kept, and consecutive text and thinking deltas
 * of one round fold into a single event, so a long answer costs one entry rather than one per
 * token. Two caps bound the record: how many entries and how many estimated bytes it may hold.
 * Past either, the OLDEST entries are dropped, so the view always shows the run's latest work.
 */
import type { SessionEvent } from "@nathapp/nax-agent";

/** The most events one task retains. */
export const TASK_EVENTS_MAX_ENTRIES = 2000;
/** The most estimated payload bytes one task retains (text, tool inputs, tool previews). */
export const TASK_EVENTS_MAX_BYTES = 2 * 1024 * 1024;
/** What an event with no measurable payload is charged, so an endless stream of them is bounded too. */
const EVENT_OVERHEAD_BYTES = 128;

/** The event types a transcript is folded from; every other type is dropped on arrival. */
const KEPT_TYPES: ReadonlySet<SessionEvent["type"]> = new Set([
  "text_delta",
  "thinking_delta",
  "tool_call",
  "tool_result",
  "compaction",
  "turn_end",
]);

export interface TaskEventLog {
  /** Record one event; an event no transcript row comes from is ignored. */
  append(event: SessionEvent): void;
  /** The retained events, oldest first. A copy: later appends never change it. */
  snapshot(): readonly SessionEvent[];
  /** Forget everything. */
  clear(): void;
}

function inputBytes(input: unknown): number {
  try {
    return JSON.stringify(input)?.length ?? 0;
  } catch {
    // An input that cannot be serialised is charged as an empty one.
    return 0;
  }
}

/** The estimated payload an event holds: the part that can be large. */
function payloadBytes(event: SessionEvent): number {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
      return event.text.length;
    case "tool_call":
      return inputBytes(event.input);
    case "tool_result":
      return event.preview.length;
    case "turn_end":
      return event.output.length;
    default:
      return 0;
  }
}

function costOf(event: SessionEvent): number {
  return EVENT_OVERHEAD_BYTES + payloadBytes(event);
}

/** Keep the newest part of a run that outgrew the byte cap on its own. */
function capped(text: string): string {
  return text.length > TASK_EVENTS_MAX_BYTES ? text.slice(-TASK_EVENTS_MAX_BYTES) : text;
}

/** `last` with `next`'s text folded in when `next` continues its run, else undefined. */
function continued(last: SessionEvent | undefined, next: SessionEvent): SessionEvent | undefined {
  if (last === undefined) return undefined;
  if (
    last.type === "text_delta" &&
    next.type === "text_delta" &&
    last.turnId === next.turnId &&
    last.round === next.round
  ) {
    return { ...last, text: capped(last.text + next.text) };
  }
  if (
    last.type === "thinking_delta" &&
    next.type === "thinking_delta" &&
    last.turnId === next.turnId &&
    last.round === next.round
  ) {
    return { ...last, text: capped(last.text + next.text) };
  }
  return undefined;
}

export function createTaskEventLog(): TaskEventLog {
  let events: SessionEvent[] = [];
  let bytes = 0;

  function trim(): void {
    let drop = 0;
    while (
      events.length - drop > 1 &&
      (events.length - drop > TASK_EVENTS_MAX_ENTRIES || bytes > TASK_EVENTS_MAX_BYTES)
    ) {
      const oldest = events[drop];
      if (oldest === undefined) break;
      bytes -= costOf(oldest);
      drop += 1;
    }
    if (drop > 0) events = events.slice(drop);
  }

  return {
    append(event) {
      if (!KEPT_TYPES.has(event.type)) return;
      const last = events.at(-1);
      const merged = continued(last, event);
      if (last !== undefined && merged !== undefined) {
        bytes += costOf(merged) - costOf(last);
        events[events.length - 1] = merged;
      } else {
        events.push(event);
        bytes += costOf(event);
      }
      trim();
    },
    snapshot: () => [...events],
    clear() {
      events = [];
      bytes = 0;
    },
  };
}
