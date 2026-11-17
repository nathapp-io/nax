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
  pendingPreviewLines,
  pushDiscardedSteer,
  pushQueued,
  pushQueuedFront,
  queueRowLines,
  queueToPrompt,
  type SteeringRow,
  steeringRowLines,
  takeQueued,
} from "@/tui/chat/message-queue";
import { displayWidth, MIN_LAYOUT_WIDTH } from "@/tui/chat/styled-line";

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

describe("pendingPreviewLines", () => {
  /** The columns these projections are drawn into: a full 80-column screen. */
  const WIDTH = 80;

  /** `count` pending steers, each naming its own arrival position. */
  function steersOf(count: number): readonly SteeringRow[] {
    return Array.from({ length: count }, (_unused, index) => ({ steerId: `s${index + 1}`, text: `s${index + 1}` }));
  }

  /** `count` queued texts, each naming its own place in the queue. */
  function queueOf(count: number): MessageQueue {
    return Array.from({ length: count }, (_unused, index) => `q${index + 1}`);
  }

  /** The previews a projection of `count` pending items shows at `budget` rows. */
  function projected(count: number, budget: number): readonly string[] {
    return pendingPreviewLines({ queued: queueOf(count), budget, columns: WIDTH });
  }

  /** Every pending item's own row, in the spec's group order: steers first, then the queue. */
  function allItems(steerCount: number, queueCount: number): readonly string[] {
    return [...steeringRowLines(steersOf(steerCount)), ...queueRowLines(queueOf(queueCount))];
  }

  test("AC-14 crosses 0, 1, 4, 5, 17 and 40 items with every budget through 4", () => {
    for (const count of [0, 1, 4, 5, 17, 40]) {
      for (const budget of [0, 1, 2, 3, 4]) {
        const rows = projected(count, budget);
        expect({ count, budget, length: rows.length }).toEqual({ count, budget, length: Math.min(count, budget) });
        // The summary sits inside the budget, never beside it: the last row is the summary.
        if (budget > 0 && count > budget) expect(rows.at(-1)).toBe(`+${count - budget + 1} pending`);
      }
    }
  });

  test("AC-15 shows the first B-1 items and counts every hidden one when 17 items meet three rows", () => {
    expect(projected(17, 3)).toEqual(["queued · q1", "queued · q2", "+15 pending"]);
  });

  test("AC-16 shows every item it can fit, steers in arrival order then queued oldest first", () => {
    const rows = pendingPreviewLines({ steering: steersOf(2), queued: queueOf(2), budget: 4, columns: WIDTH });
    expect(rows).toEqual(allItems(2, 2));
    expect(rows).toEqual(["steering · s1", "steering · s2", "queued · q1", "queued · q2"]);
  });

  test("AC-16 shows no summary row when everything fits, whatever the budget", () => {
    expect(projected(4, 4)).toEqual(["queued · q1", "queued · q2", "queued · q3", "queued · q4"]);
    expect(pendingPreviewLines({ steering: steersOf(2), queued: queueOf(2), columns: WIDTH })).toEqual(allItems(2, 2));
  });

  test("AC-17 counts the hidden items across both groups on the final row", () => {
    expect(pendingPreviewLines({ steering: steersOf(3), queued: queueOf(2), budget: 3, columns: WIDTH })).toEqual([
      "steering · s1",
      "steering · s2",
      "+3 pending",
    ]);
  });

  test("AC-18 with one whole row for more than one item, draws only the combined summary", () => {
    expect(pendingPreviewLines({ steering: steersOf(1), queued: queueOf(1), budget: 1, columns: WIDTH })).toEqual([
      "+2 pending",
    ]);
    expect(projected(17, 1)).toEqual(["+17 pending"]);
  });

  test("AC-19 with one row for exactly one item, draws that item's labelled preview", () => {
    expect(pendingPreviewLines({ steering: steersOf(1), budget: 1, columns: WIDTH })).toEqual(["steering · s1"]);
    expect(projected(1, 1)).toEqual(["queued · q1"]);
  });

  test("AC-20 draws nothing at all for a zero-row budget", () => {
    expect(pendingPreviewLines({ steering: steersOf(3), queued: queueOf(2), budget: 0, columns: WIDTH })).toEqual([]);
  });

  test("AC-20 draws nothing when nothing is pending, whatever the budget", () => {
    expect(pendingPreviewLines({ steering: [], queued: [], budget: 4, columns: WIDTH })).toEqual([]);
  });

  test("AC-21 flattens line breaks and strips escapes so each item stays one row", () => {
    expect(
      pendingPreviewLines({ steering: [{ steerId: "s1", text: "\u001b[2Jone\ntwo" }], budget: 4, columns: WIDTH }),
    ).toEqual(["steering · one two"]);
  });

  test("AC-21 cuts a projection to the columns it is drawn into", () => {
    const [row] = pendingPreviewLines({ queued: ["x".repeat(80)], budget: 4, columns: 20 });
    expect(displayWidth(row ?? "")).toBe(20);
  });

  test("AC-21 draws a width below the supported minimum at that minimum", () => {
    // A terminal that reports nothing usable is drawn at the layout's own floor, still cut.
    for (const columns of [0, 4, Number.NaN]) {
      const rows = pendingPreviewLines({ queued: ["x".repeat(200)], budget: 4, columns });
      expect({ columns, widths: rows.map(displayWidth) }).toEqual({ columns, widths: [MIN_LAYOUT_WIDTH] });
    }
  });

  test("AC-21 fits a long preview inside the width the caller gave", () => {
    const rows = pendingPreviewLines({ steering: [{ steerId: "s1", text: "y".repeat(200) }], budget: 4, columns: 40 });
    expect(rows.map(displayWidth)).toEqual([40]);
  });

  test("AC-22 leaves the stored messages, the order and the steering rows untouched", () => {
    const steering: readonly SteeringRow[] = steersOf(3);
    const queued: MessageQueue = queueOf(17);
    pendingPreviewLines({ steering, queued, budget: 4, columns: WIDTH });
    expect(steering).toEqual(steersOf(3));
    expect(queued).toEqual(queueOf(17));
    expect(steering.map((row) => row.steerId)).toEqual(["s1", "s2", "s3"]);
    expect(queued[0]).toBe("q1");
    expect(queued.at(-1)).toBe("q17");
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
