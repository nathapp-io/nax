/**
 * US-001: up on an empty prompt recalls the queued messages into the prompt.
 *
 * A line typed during a turn waits in the queue, drawn as a muted `queued · <text>` row, and
 * until this feature the only way to correct one was to let it go. Up on an empty prompt now
 * moves every queued message into the prompt as one editable multiline draft, oldest first,
 * and empties the queue at the keypress — so nothing the user is editing goes out behind
 * their back. Up with text in the prompt, up with nothing queued, shift+up and up while the
 * slash menu owns the key all keep the behaviour they had.
 *
 * The host is the shared `mountChatPicker` fake, so what is asserted is what a user would see
 * on the frame and what the host was actually asked to do.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEventBody, TurnEndStatus } from "@nathapp/nax-agent";
import { mountChatPicker as mount } from "@test/helpers";
import { cleanup } from "ink-testing-library";

/** ink parses the arrows as a terminal sends them. */
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_UP = "\x1b[1;2A";
const RETURN = "\r";
/** The marker the screen draws in front of a queued message. */
const QUEUED = "queued · ";
/** The glyph a rule line is drawn from: the prompt's text rows sit between two of them. */
const RULE = "─";
/** The microtask rounds a settle needs to reach the end of a send's `finally`. */
const FLUSHES = 6;
/** A transcript of a hundred code lines, each named so a frame can say which it shows. */
const CODE_LINES = Array.from({ length: 100 }, (_unused, index) => `zz${String(index + 1).padStart(3, "0")}`);
const NEWEST_CODE_LINE = CODE_LINES[CODE_LINES.length - 1] ?? "";

afterEach(() => {
  cleanup();
});

/** The rows that carry the queue's muted marker, in the order they are drawn. */
const queuedRows = (rows: readonly string[]): readonly string[] => rows.filter((row) => row.startsWith(QUEUED));

/** The index of the last row matching `predicate`, or -1 — the frame is read bottom-up. */
function lastIndexOf(rows: readonly string[], predicate: (row: string) => boolean): number {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row !== undefined && predicate(row)) return index;
  }
  return -1;
}

/**
 * The prompt's own rows: everything between the two rule lines that frame the input. A
 * recalled draft is several rows, so a case reads all of them — the transcript draws its own
 * `> ` rows, and only this window is the input's.
 */
function promptRows(rows: readonly string[]): readonly string[] {
  const closing = lastIndexOf(rows, (row) => row.startsWith(RULE));
  const opening = lastIndexOf(rows.slice(0, closing), (row) => row.startsWith(RULE));
  return rows.slice(opening + 1, closing);
}

/** A turn's own end event: what the screen watches to decide what to send next. */
function turnEnd(status: TurnEndStatus): SessionEventBody {
  return {
    type: "turn_end",
    status,
    output: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
  };
}

/** The mounted screen over the shared fake host, and the verbs these cases drive it with. */
function screen() {
  const ui = mount();
  /** A line typed into the prompt without submitting it. */
  const type = (text: string): void => {
    for (const char of text) ui.press(char);
  };
  /** The frame's rows as the terminal shows them, refreshed for this read. */
  const rows = (): string[] => ui.rows();
  /** The input's own text rows: where a recalled draft lands. */
  const prompt = (): readonly string[] => promptRows(rows());
  /** Let the microtasks a send's `finally` runs settle, so the drain has finished. */
  const flush = async (): Promise<void> => {
    for (let round = 0; round < FLUSHES; round++) await ui.settle();
  };
  /** Return on its own, for a line already in the prompt. */
  const pressReturn = async (): Promise<void> => {
    ui.press(RETURN);
    await flush();
  };
  /** Up, the key this feature is about, in its own act: it does its work synchronously. */
  const recall = (): void => ui.press(UP);
  /** End the running turn with `status`, then let its send settle and the drain that follows. */
  const endTurn = async (status: TurnEndStatus = "cancelled"): Promise<void> => {
    ui.emit(turnEnd(status));
    await ui.finish();
    await flush();
  };
  return { ...ui, type, rows, prompt, flush, pressReturn, recall, endTurn };
}

/** A screen with `hello` running and `lines` queued behind it. */
async function queuedScreen(lines: readonly string[]) {
  const ui = screen();
  await ui.submit("hello");
  for (const line of lines) await ui.submit(line);
  return ui;
}

describe("up on an empty prompt with a queued line", () => {
  test("AC-1 moves every queued line into the prompt, oldest first", async () => {
    const ui = await queuedScreen(["first", "second"]);
    expect(ui.prompt()).toEqual([">"]);
    ui.recall();
    expect(ui.prompt()).toEqual(["> first", "  second"]);
  });

  test("AC-2 draws no queued row once the lines are in the prompt", async () => {
    const ui = await queuedScreen(["first", "second"]);
    expect(queuedRows(ui.rows())).toEqual([`${QUEUED}first`, `${QUEUED}second`]);
    ui.recall();
    expect(queuedRows(ui.rows())).toEqual([]);
  });

  test("AC-3 the recalled draft returns as one queued message and is sent when the turn completes", async () => {
    const ui = await queuedScreen(["first", "second"]);
    ui.recall();
    await ui.pressReturn();
    expect(queuedRows(ui.rows())).toEqual(["queued · first second"]);
    await ui.endTurn("completed");
    expect(ui.host.send).toHaveBeenCalledTimes(2);
    expect(ui.host.send).toHaveBeenNthCalledWith(2, "first\nsecond", expect.any(Function));
  });

  test("AC-4 a completed turn sends nothing the user recalled and has not returned", async () => {
    const ui = await queuedScreen(["first"]);
    ui.recall();
    await ui.endTurn("completed");
    expect(ui.host.send).toHaveBeenCalledTimes(1);
    expect(ui.host.send).not.toHaveBeenCalledWith("first");
    // The line is the prompt's until the user returns it.
    expect(ui.prompt()).toEqual(["> first"]);
    await ui.pressReturn();
    expect(ui.host.send).toHaveBeenCalledTimes(2);
    expect(ui.host.send).toHaveBeenLastCalledWith("first", expect.any(Function));
  });

  test("AC-5 a cancelled turn leaves the recalled draft in the prompt exactly once", async () => {
    const ui = await queuedScreen(["first"]);
    ui.recall();
    await ui.endTurn("cancelled");
    expect(ui.prompt()).toEqual(["> first"]);
  });

  test.each(["completed", "cancelled"] as const)(
    "AC-18 a turn that settles %s leaves the recalled draft exactly as it was",
    async (status) => {
      const ui = await queuedScreen(["first"]);
      ui.recall();
      await ui.endTurn(status);
      expect(ui.prompt()).toEqual(["> first"]);
    },
  );

  test.each(["completed", "cancelled"] as const)(
    "AC-19 a turn that settles %s sends nothing after the drain",
    async (status) => {
      const ui = await queuedScreen(["first"]);
      ui.recall();
      // The premise: the line is the prompt's now, so nothing is left for a drain to send.
      expect(ui.prompt()).toEqual(["> first"]);
      expect(ui.host.send).toHaveBeenCalledTimes(1);
      await ui.endTurn(status);
      expect(ui.host.send).toHaveBeenCalledTimes(1);
    },
  );
});

describe("up that must not recall anything", () => {
  test("AC-6 up with text in the prompt leaves the line queued", async () => {
    const ui = await queuedScreen(["first"]);
    ui.type("draft");
    ui.recall();
    expect(ui.prompt().some((row) => row.includes("first"))).toBe(false);
    expect(queuedRows(ui.rows())).toEqual(["queued · first"]);
  });

  test("AC-8 shift+up leaves the prompt empty and the line queued", async () => {
    const ui = await queuedScreen(["first"]);
    ui.press(SHIFT_UP);
    expect(ui.prompt()).toEqual([">"]);
    expect(queuedRows(ui.rows())).toEqual(["queued · first"]);
  });

  test("AC-15 up with the slash menu open moves its selection back to the first match", async () => {
    const ui = screen();
    ui.type("/re");
    expect(ui.rows().some((row) => row.startsWith("❯ /resume"))).toBe(true);
    ui.press(DOWN);
    expect(ui.rows().some((row) => row.startsWith("❯ /feature"))).toBe(true);
    ui.press(UP);
    expect(ui.rows().some((row) => row.startsWith("❯ /resume"))).toBe(true);
    expect(ui.rows().some((row) => row.startsWith("❯ /feature"))).toBe(false);
  });

  test("AC-17 shift+up scrolls one line toward older transcript content", async () => {
    const ui = await queuedScreen(["first"]);
    ui.emit({ type: "text_delta", round: 1, text: `\`\`\`ts\n${CODE_LINES.join("\n")}\n\`\`\`` });
    expect(ui.rows().join("\n")).toContain(NEWEST_CODE_LINE);
    ui.press(SHIFT_UP);
    expect(ui.rows().join("\n")).not.toContain(NEWEST_CODE_LINE);
    expect(queuedRows(ui.rows())).toEqual(["queued · first"]);
  });
});

describe("up with nothing queued", () => {
  test("AC-7 still recalls the input history, as before this feature", async () => {
    const ui = screen();
    await ui.submit("earlier");
    ui.recall();
    expect(ui.prompt()).toEqual(["> earlier"]);
  });
});
