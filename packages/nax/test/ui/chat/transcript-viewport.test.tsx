import { afterEach, describe, expect, test } from "bun:test";
import chalk from "chalk";
import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { EMPTY_LINE } from "@/tui/chat/layout";
import type { StyledLine } from "@/tui/chat/styled-line";
import { TranscriptViewport } from "@/tui/chat/TranscriptViewport";
import { resolveChatTheme } from "@/tui/chat/theme";
import { fakeMouse } from "./mouse";

/** Colour off, so every frame is the plain row text and no assertion depends on escapes. */
const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const HEIGHT = 5;

/** The sequences ink parses into the keys the viewport owns. */
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

const UNSEEN = "new lines (End)";

afterEach(() => {
  cleanup();
});

/** `count` numbered one-span lines, so a frame row names the transcript line it shows. */
function numbered(count: number): StyledLine[] {
  return Array.from({ length: count }, (_unused, index) => [{ text: `line ${index + 1}` }]);
}

function rowsOf(lastFrame: string | undefined): string[] {
  return (lastFrame ?? "").split("\n").map((row) => row.trim());
}

interface MountOptions {
  readonly active?: boolean;
  readonly height?: number;
  /** The columns the window is given; omitted means the harness default (100). */
  readonly width?: number;
}

/** Mount the viewport and expose the harness verbs the tests need. */
function mount(lines: StyledLine[], { active = true, height = HEIGHT, width }: MountOptions = {}) {
  const window = (next: StyledLine[]) => (
    <TranscriptViewport lines={next} height={height} theme={THEME} active={active} />
  );
  const frame = (next: StyledLine[]) => (width === undefined ? window(next) : <Box width={width}>{window(next)}</Box>);
  const ui = render(frame(lines));
  return {
    rows: () => rowsOf(ui.lastFrame()),
    press: (sequence: string) =>
      act(() => {
        ui.stdin.write(sequence);
      }),
    update: (next: StyledLine[]) =>
      Promise.resolve(
        act(async () => {
          ui.rerender(frame(next));
        }),
      ),
  };
}

describe("TranscriptViewport", () => {
  test("US-006 AC-3 pads three lines below in a ten-row window", () => {
    const view = mount(numbered(3), { height: 10 });
    expect(view.rows()).toEqual(["line 1", "line 2", "line 3", "", "", "", "", "", "", ""]);
  });

  test("US-006 AC-4 preserves follow and the bottom unseen marker in a ten-row window", async () => {
    const view = mount(numbered(20), { height: 10 });
    expect(view.rows()).toEqual(
      numbered(20)
        .slice(10)
        .map((line) => line[0].text),
    );
    await view.update(numbered(23));
    expect(view.rows().at(-1)).toBe("line 23");
    view.press(PAGE_UP);
    await view.update(numbered(25));
    expect(view.rows()).toEqual([
      "line 5",
      "line 6",
      "line 7",
      "line 8",
      "line 9",
      "line 10",
      "line 11",
      "line 12",
      "line 13",
      "↓ 2 new lines (End)",
    ]);
    view.press(END);
    expect(view.rows().at(-1)).toBe("line 25");
    expect(view.rows()).toHaveLength(10);
  });

  test("AC-2 shows the newest page of a transcript longer than the view", () => {
    const view = mount(numbered(20));
    expect(view.rows()).toEqual(["line 16", "line 17", "line 18", "line 19", "line 20"]);
  });

  test("AC-3 pageUp scrolls the newest line out of the frame", () => {
    const view = mount(numbered(20));
    view.press(PAGE_UP);
    expect(view.rows()).not.toContain("line 20");
  });

  test("AC-4 pageUp keeps the newest line of the previous page in the frame", () => {
    const view = mount(numbered(20));
    view.press(PAGE_UP);
    expect(view.rows()).toEqual(["line 12", "line 13", "line 14", "line 15", "line 16"]);
  });

  test("AC-5 the last row counts the lines that arrived while scrolled up", async () => {
    const view = mount(numbered(20));
    view.press(PAGE_UP);
    await view.update(numbered(23));
    expect(view.rows().at(-1)).toBe("↓ 3 new lines (End)");
  });

  test("AC-6 end returns to the newest line and drops the unseen row", async () => {
    const view = mount(numbered(20));
    view.press(PAGE_UP);
    await view.update(numbered(23));
    expect(view.rows().some((row) => row.includes(UNSEEN))).toBe(true);
    view.press(END);
    expect(view.rows()).toEqual(["line 19", "line 20", "line 21", "line 22", "line 23"]);
    expect(view.rows().some((row) => row.includes(UNSEEN))).toBe(false);
  });

  test("AC-7 shift+upArrow moves the view up one line", () => {
    const view = mount(numbered(20));
    view.press(SHIFT_UP);
    expect(view.rows()).toEqual(["line 15", "line 16", "line 17", "line 18", "line 19"]);
  });

  test("AC-8 home shows the first page", () => {
    const view = mount(numbered(20));
    view.press(HOME);
    expect(view.rows()).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5"]);
  });

  test("AC-9 keys on an inactive viewport leave the frame unchanged", () => {
    const view = mount(numbered(20), { active: false });
    const frame = view.rows();
    for (const sequence of [PAGE_UP, SHIFT_UP, HOME, END, PAGE_DOWN, SHIFT_DOWN]) view.press(sequence);
    expect(view.rows()).toEqual(frame);
    expect(frame).toEqual(["line 16", "line 17", "line 18", "line 19", "line 20"]);
  });

  test("pageDown pages back down to the newest line and clears the unseen row", async () => {
    const view = mount(numbered(20));
    view.press(PAGE_UP);
    await view.update(numbered(23));
    view.press(PAGE_DOWN);
    expect(view.rows().at(0)).toBe("line 16");
    expect(view.rows().at(-1)).toBe("↓ 3 new lines (End)");
    view.press(PAGE_DOWN);
    expect(view.rows()).toEqual(["line 19", "line 20", "line 21", "line 22", "line 23"]);
    expect(view.rows().some((row) => row.includes(UNSEEN))).toBe(false);
  });

  test("shift+downArrow moves the view down one line", () => {
    const view = mount(numbered(20));
    view.press(SHIFT_UP);
    view.press(SHIFT_DOWN);
    expect(view.rows()).toEqual(["line 16", "line 17", "line 18", "line 19", "line 20"]);
  });

  test("keys the view does not own leave the frame alone", () => {
    const view = mount(numbered(20));
    for (const sequence of [UP, DOWN, "A", "\x1b[Z"]) view.press(sequence);
    expect(view.rows()).toEqual(["line 16", "line 17", "line 18", "line 19", "line 20"]);
  });

  test("lines that arrive while following keep the newest line in view", async () => {
    const view = mount(numbered(20));
    await view.update(numbered(23));
    expect(view.rows()).toEqual(["line 19", "line 20", "line 21", "line 22", "line 23"]);
  });

  test("a transcript that shrinks while scrolled up shows its first page", async () => {
    const view = mount(numbered(20));
    view.press(PAGE_UP);
    await view.update(numbered(5));
    expect(view.rows()).toEqual(["line 1", "line 2", "line 3", "line 4", "line 5"]);
    expect(view.rows().some((row) => row.includes(UNSEEN))).toBe(false);
  });

  test("an empty transcript fills the window with blank rows", () => {
    expect(mount([]).rows()).toEqual(["", "", "", "", ""]);
  });

  test("a one-row window shows only the newest line", () => {
    const view = mount(numbered(20), { height: 1 });
    expect(view.rows()).toEqual(["line 20"]);
    view.press(SHIFT_UP);
    expect(view.rows()).toEqual(["line 19"]);
  });

  test("a window height below one row still draws one row", () => {
    expect(mount(numbered(20), { height: 0 }).rows()).toEqual(["line 20"]);
  });

  test("F1 an empty line still occupies a row", () => {
    // `layoutTranscript` separates entries with `EMPTY_LINE`; an empty line and a line of
    // empty spans must each keep the row they were given, or the transcript loses its gaps.
    const lines: StyledLine[] = [[{ text: "a" }], EMPTY_LINE, [{ text: "" }], [{ text: "b" }]];
    expect(mount(lines, { height: 4 }).rows()).toEqual(["a", "", "", "b"]);
  });

  test("F2 the unseen marker stays on the last row of a narrow window", async () => {
    const view = mount(numbered(20), { width: 10 });
    view.press(PAGE_UP);
    await view.update(numbered(23));
    const rows = view.rows();
    expect(rows).toHaveLength(HEIGHT);
    expect(rows.filter((row) => row.startsWith("↓"))).toEqual(["↓ 3 new l…"]);
  });

  test("F2 content lines wider than the window do not grow it", () => {
    const wide: StyledLine[] = [[{ text: "a line far wider than ten columns" }], [{ text: "b" }]];
    const rows = mount(wide, { height: 2, width: 10 }).rows();
    expect(rows).toHaveLength(2);
    expect(rows.at(0)).toBe("a line far");
    expect(rows.at(1)).toBe("b");
  });
});

describe("TranscriptViewport mouse", () => {
  const lines: StyledLine[] = Array.from({ length: 50 }, (_, index) => [{ text: `line-${index}` }]);
  const labels = (start: number, count = 10) => Array.from({ length: count }, (_, index) => `line-${start + index}`);
  test("US003 AC-13 scrolls up three rows and down again wherever the pointer is", () => {
    const mouse = fakeMouse();
    const ui = render(<TranscriptViewport lines={lines} height={10} theme={THEME} mouse={mouse.events} />);
    expect(rowsOf(ui.lastFrame())).toEqual(labels(40));
    act(() => mouse.emit("wheelUp"));
    expect(rowsOf(ui.lastFrame())).toEqual(labels(37));
    act(() => mouse.emit("wheelDown"));
    expect(rowsOf(ui.lastFrame())).toEqual(labels(40));
    act(() => mouse.emit("move"));
    expect(rowsOf(ui.lastFrame())).toEqual(labels(40));
    ui.unmount();
    expect(mouse.listeners.size).toBe(0);
  });
  test("US003 AC-14 ignores wheel events while inactive and unsubscribes on deactivation", async () => {
    const mouse = fakeMouse();
    const frame = (active: boolean) => (
      <TranscriptViewport lines={lines} height={10} theme={THEME} mouse={mouse.events} active={active} />
    );
    const ui = render(frame(false));
    act(() => mouse.emit("wheelUp"));
    expect(rowsOf(ui.lastFrame())).toEqual(labels(40));
    expect(mouse.listeners.size).toBe(0);
    await Promise.resolve(act(async () => ui.rerender(frame(true))));
    expect(mouse.listeners.size).toBe(2);
    await Promise.resolve(act(async () => ui.rerender(frame(false))));
    act(() => mouse.emit("wheelUp"));
    expect(rowsOf(ui.lastFrame())).toEqual(labels(40));
    expect(mouse.listeners.size).toBe(0);
  });
  test("US003 AC-17 PageUp without a mouse keeps the one-row overlap", () => {
    const ui = render(<TranscriptViewport lines={lines.slice(0, 20)} height={5} theme={THEME} />);
    act(() => {
      ui.stdin.write(PAGE_UP);
    });
    expect(rowsOf(ui.lastFrame())).toEqual(labels(11, 5));
  });
});

describe("US005 TranscriptViewport selection", () => {
  test("US-006 AC-6 copies the first two lines above bottom padding", () => {
    const mouse = fakeMouse();
    const copies: string[] = [];
    const ui = render(
      <TranscriptViewport
        lines={numbered(3)}
        height={10}
        theme={THEME}
        mouse={mouse.events}
        onCopy={(text) => copies.push(text)}
      />,
    );
    const event = (kind: "press" | "drag" | "release", x: number, y: number) =>
      act(() => mouse.emit(kind, { button: "left", x, y }));
    event("press", 1, 1);
    event("drag", 6, 2);
    event("release", 6, 2);
    expect(copies).toEqual(["line 1\nline 2"]);
    expect(rowsOf(ui.lastFrame()).slice(3)).toEqual(Array(7).fill(""));
    event("press", 1, 4);
    event("drag", 6, 5);
    event("release", 6, 5);
    expect(copies).toEqual(["line 1\nline 2"]);
  });
  const inverse = "\x1b[7mhello\x1b[27m";
  function selectionView() {
    const mouse = fakeMouse();
    const copies: string[] = [];
    const frame = (lines: StyledLine[]) => (
      <TranscriptViewport
        lines={lines}
        height={2}
        top={0}
        theme={THEME}
        mouse={mouse.events}
        onCopy={(text) => copies.push(text)}
      />
    );
    const ui = render(frame([[{ text: "hello world" }]]));
    const event = (kind: "press" | "drag" | "release", x: number, y = 1) =>
      act(() => mouse.emit(kind, { button: "left", x, y }));
    const drag = () => {
      event("press", 1);
      event("drag", 5);
      event("release", 5);
    };
    return {
      ...ui,
      copies,
      event,
      drag,
      update: async (lines: StyledLine[]) => {
        await Promise.resolve(act(async () => ui.rerender(frame(lines))));
      },
    };
  }
  test("AC-1/2 copies hello exactly once, not again on duplicate release", () => {
    const ui = selectionView();
    ui.drag();
    expect(ui.copies).toEqual(["hello"]);
    ui.event("release", 5);
    expect(ui.copies).toEqual(["hello"]);
  });
  test("AC-3 click does not copy", () => {
    const ui = selectionView();
    ui.event("press", 1);
    ui.event("release", 1);
    expect(ui.copies).toEqual([]);
    ui.drag();
    expect(ui.copies).toEqual(["hello"]);
  });
  test.each(["press", "same-count", "count-change", "outside"])(
    "AC-5/6/7/8/9 inverse lifecycle: %s",
    async (change) => {
      const level = chalk.level;
      chalk.level = 1;
      try {
        const ui = selectionView();
        ui.drag();
        expect(ui.lastFrame()).toContain(inverse);
        if (change === "press") ui.event("press", 8);
        if (change === "outside") ui.event("press", 1, 3);
        if (change === "same-count") await ui.update([[{ text: "hello streamed" }]]);
        if (change === "count-change") {
          await ui.update([[{ text: "hello world" }], [{ text: "new" }]]);
          expect(ui.lastFrame()).toContain("hello world"); // The old selected row is still visible.
        }
        if (change === "same-count") expect(ui.lastFrame()).toContain(inverse);
        else expect(ui.lastFrame()).not.toContain("\x1b[7mhello");
      } finally {
        chalk.level = level;
      }
    },
  );
  test("#2718 a drag over a blank row copies nothing", async () => {
    const ui = selectionView();
    await ui.update([EMPTY_LINE, [{ text: "hello world" }]]);
    ui.event("press", 1, 1);
    ui.event("drag", 5, 1);
    ui.event("release", 5, 1);
    expect(ui.copies).toEqual([]);
    ui.event("press", 1, 2);
    ui.event("drag", 5, 2);
    ui.event("release", 5, 2);
    expect(ui.copies).toEqual(["hello"]);
  });
  test("drag outside retains focus and release copies the last inside range", () => {
    const ui = selectionView();
    ui.event("press", 1);
    ui.event("drag", 5);
    ui.event("drag", 9, 3);
    ui.event("release", 9, 3);
    expect(ui.copies).toEqual(["hello"]);
  });
  test("AC-15 optional mouse/top/copy preserve default newest page without inverse", () => {
    const lines: StyledLine[] = Array.from({ length: 50 }, (_, i) => [{ text: `line-${i}` }]);
    const ui = render(<TranscriptViewport lines={lines} height={10} theme={THEME} />);
    expect(rowsOf(ui.lastFrame())).toEqual(Array.from({ length: 10 }, (_, i) => `line-${40 + i}`));
    expect(ui.lastFrame()).not.toContain("\x1b[7m");
  });
});
