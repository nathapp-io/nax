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
  pushQueued,
  pushQueuedFront,
  queueRowLines,
  queueToPrompt,
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
