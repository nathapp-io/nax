import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import type { StyledLine } from "@/tui/chat/styled-line";
import { TranscriptViewport } from "@/tui/chat/TranscriptViewport";
import { resolveChatTheme } from "@/tui/chat/theme";

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

/** Mount the viewport with a height every test shares, and expose the harness verbs it needs. */
function mount(lines: StyledLine[], active = true) {
  const show = (next: StyledLine[]) =>
    render(<TranscriptViewport lines={next} height={HEIGHT} theme={THEME} active={active} />);
  const ui = show(lines);
  return {
    rows: () => rowsOf(ui.lastFrame()),
    press: (sequence: string) =>
      act(() => {
        ui.stdin.write(sequence);
      }),
    update: (next: StyledLine[]) =>
      Promise.resolve(
        act(async () => {
          ui.rerender(<TranscriptViewport lines={next} height={HEIGHT} theme={THEME} active={active} />);
        }),
      ),
  };
}

describe("TranscriptViewport", () => {
  test("AC-1 pads a transcript shorter than the view with empty rows at the top", () => {
    const view = mount(numbered(3));
    expect(view.rows()).toEqual(["", "", "line 1", "line 2", "line 3"]);
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
    const view = mount(numbered(20), false);
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
});
