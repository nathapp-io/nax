/**
 * The message queue's value semantics: what a push and a take do to the lists, how a queue
 * that has to go back into the prompt is joined, and how many rows it claims on screen.
 *
 * Every operation is a pure function over a readonly list, so each case asserts the value it
 * returned *and* that the list it was given is untouched — the queue is state the screen
 * replaces, never one it edits.
 */
import { describe, expect, test } from "bun:test";
import {
  MAX_QUEUED_ROWS,
  type MessageQueue,
  pushDiscardedSteer,
  pushQueued,
  pushQueuedFront,
  queueRowLines,
  queueToPrompt,
  steeringRowLines,
  takeQueued,
} from "@/tui/chat/message-queue";

describe("takeQueued", () => {
  test("AC-1 takes the oldest message and leaves the rest in order", () => {
    const queue = pushQueued(pushQueued([], "a"), "b");
    expect(takeQueued(queue)).toEqual({ text: "a", rest: ["b"] });
  });

  test("AC-2 returns undefined for an empty queue", () => {
    expect(takeQueued([])).toBeUndefined();
  });

  test("AC-3 takes a message pushed to the front before the ones queued earlier", () => {
    expect(takeQueued(pushQueuedFront(["a"], "z"))).toEqual({ text: "z", rest: ["a"] });
  });

  test("taking the last message leaves an empty queue", () => {
    expect(takeQueued(["only"])).toEqual({ text: "only", rest: [] });
  });
});

describe("queueToPrompt", () => {
  test("AC-4 puts every queued text above the draft, one line each", () => {
    expect(queueToPrompt(["a", "b"], "c")).toBe("a\nb\nc");
  });

  test("AC-5 leaves no trailing line when the prompt is empty", () => {
    expect(queueToPrompt(["a", "b"], "")).toBe("a\nb");
  });

  test("an empty queue leaves the prompt holding its own draft", () => {
    expect(queueToPrompt([], "draft")).toBe("draft");
  });

  test("keeps the draft exactly as typed, spaces and line breaks included", () => {
    expect(queueToPrompt(["a"], "  two\nlines ")).toBe("a\n  two\nlines ");
  });
});

describe("pushQueued", () => {
  test("appends without touching the queue it was given", () => {
    const queue: MessageQueue = ["a"];
    const pushed = pushQueued(queue, "b");
    expect(pushed).toEqual(["a", "b"]);
    expect(queue).toEqual(["a"]);
    expect(pushed).not.toBe(queue);
  });

  test("appends to an empty queue as the only message", () => {
    expect(pushQueued([], "a")).toEqual(["a"]);
  });
});

describe("pushQueuedFront", () => {
  test("puts the message ahead of everything already queued, without mutating it", () => {
    const queue: MessageQueue = ["a", "b"];
    const pushed = pushQueuedFront(queue, "z");
    expect(pushed).toEqual(["z", "a", "b"]);
    expect(queue).toEqual(["a", "b"]);
  });
});

describe("pushDiscardedSteer", () => {
  test("B3 two discarded steers keep the order they were steered in, ahead of the queue", () => {
    const first = pushDiscardedSteer(undefined, ["q1"], "first");
    expect(first.queue).toEqual(["first", "q1"]);
    const second = pushDiscardedSteer(first.group, first.queue, "second");
    expect(second.queue).toEqual(["first", "second", "q1"]);
    expect(second.group.texts).toEqual(["first", "second"]);
  });

  test("B3 a line queued after the first discard stays behind the whole group", () => {
    const first = pushDiscardedSteer(undefined, [], "first");
    const queued = pushQueued(first.queue, "later");
    const second = pushDiscardedSteer(first.group, queued, "second");
    expect(second.queue).toEqual(["first", "second", "later"]);
  });

  test("B3 a group the queue no longer leads with starts a new one", () => {
    const first = pushDiscardedSteer(undefined, ["q1"], "first");
    // The queue was restored into the prompt and refilled since: the group has left it.
    const second = pushDiscardedSteer(first.group, ["q2"], "second");
    expect(second.queue).toEqual(["second", "q2"]);
    expect(second.group.texts).toEqual(["second"]);
  });

  test("B3 the queue it was given is untouched", () => {
    const queue: MessageQueue = ["q1"];
    const placed = pushDiscardedSteer(undefined, queue, "first");
    expect(queue).toEqual(["q1"]);
    expect(placed.queue).not.toBe(queue);
  });
});

describe("queueRowLines", () => {
  /** `count` queued texts, each naming its own place in the queue. */
  function queueOf(count: number): MessageQueue {
    return Array.from({ length: count }, (_unused, index) => `m${index + 1}`);
  }

  test("draws one muted marker row per queued message, oldest first", () => {
    expect(queueRowLines(["first", "second"])).toEqual(["queued · first", "queued · second"]);
  });

  test("AC-18 draws three rows and counts the rest when five are queued", () => {
    const rows = queueRowLines(queueOf(5));
    expect(rows).toHaveLength(MAX_QUEUED_ROWS + 1);
    expect(rows.filter((row) => row.startsWith("queued ·"))).toHaveLength(MAX_QUEUED_ROWS);
    expect(rows.at(-1)).toBe("+2 more");
  });

  test("draws no more row when the queue is exactly the row budget", () => {
    expect(queueRowLines(queueOf(MAX_QUEUED_ROWS))).toHaveLength(MAX_QUEUED_ROWS);
  });

  test("claims no rows for an empty queue", () => {
    expect(queueRowLines([])).toEqual([]);
  });

  test("keeps a multi-line message on one row", () => {
    expect(queueRowLines(["one\ntwo"])).toEqual(["queued · one two"]);
  });

  test("strips an escape sequence a queued line carries", () => {
    expect(queueRowLines(["\u001b[2Jred"])).toEqual(["queued · red"]);
  });
});

describe("steeringRowLines", () => {
  test("US-004 draws one muted marker row per pending steer, in arrival order", () => {
    const rows = steeringRowLines([
      { steerId: "s1", text: "look at b.ts" },
      { steerId: "s2", text: "then b.ts" },
    ]);
    expect(rows).toEqual(["steering · look at b.ts", "steering · then b.ts"]);
  });

  test("claims no rows when no steer is pending", () => {
    expect(steeringRowLines([])).toEqual([]);
  });

  test("keeps a multi-line steer on one row", () => {
    expect(steeringRowLines([{ steerId: "s1", text: "one\ntwo" }])).toEqual(["steering · one two"]);
  });

  test("strips an escape sequence a steer carries", () => {
    expect(steeringRowLines([{ steerId: "s1", text: "\u001b[2Jred" }])).toEqual(["steering · red"]);
  });
});
