/**
 * ChatInput focus cursor and an owner's esc.
 *
 * An empty, focused, idle prompt used to draw only the muted placeholder, so nothing on
 * screen said the input had focus; it now draws the placeholder's first cell inverse, the
 * way a nonempty draft draws its cursor cell. The other half of the story is the owner's
 * escape: while `onEscape` is set the input hands every escape to its owner instead of
 * arming its own two-press clear.
 *
 * The harness mounts the input under a small owner that holds the `InputDraft`, exactly as
 * `ChatApp` does. A colourless theme keeps every row plain text; the cursor cases raise
 * chalk's level instead, because the inverse cell is the one part of a frame that carries
 * no text of its own.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeFakeClock } from "@test/helpers";
import chalk from "chalk";
import { cleanup, render } from "ink-testing-library";
import { act, type ReactElement, useState } from "react";
import { _chatInputDeps, ChatInput, DOUBLE_ESCAPE_MS, EMPTY_DRAFT, type InputDraft } from "@/tui/chat/ChatInput";
import { EMPTY_EDITOR } from "@/tui/chat/line-editor";
import { resolveChatTheme } from "@/tui/chat/theme";

/** Colour off: every token undefined, so every frame row is the plain characters. */
const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const WIDTH = 20;
const RULE = THEME.glyphs.rule.repeat(WIDTH);
const PLACEHOLDER = 'Try "explain how nax run picks a model" · / for commands';

/** The sequence ink parses into the escape key. */
const ESCAPE = "\x1b";

/** Full colour, so ink surrounds the inverse cursor cell with the SGR 7 / SGR 27 pair. */
const FULL_COLOR = 3;
const INVERSE_ON = "\u001b[7m";
const INVERSE_OFF = "\u001b[27m";

/**
 * The text an inverse cell covers, read out of the raw frame by locating the SGR pair —
 * the one part of a frame that carries no characters of its own.
 */
function inverseCell(frame: string): string {
  const start = frame.indexOf(INVERSE_ON);
  if (start < 0) return "";
  const from = start + INVERSE_ON.length;
  const end = frame.indexOf(INVERSE_OFF, from);
  return end < 0 ? "" : frame.slice(from, end);
}

const originalDeps = { ..._chatInputDeps };
const originalChalkLevel = chalk.level;
afterEach(() => {
  cleanup();
  Object.assign(_chatInputDeps, originalDeps);
  chalk.level = originalChalkLevel;
});

interface MountOptions {
  readonly active?: boolean;
  readonly busy?: boolean;
  readonly hint?: string;
  readonly initialDraft?: InputDraft;
  /** The owner's escape — while set it replaces the input's own two-press clear. */
  readonly onEscape?: () => void;
  /** An open menu beneath the input, which owns the navigation keys including escape. */
  readonly yieldNavigation?: boolean;
  /** Render with colour forced on, so the inverse cell is visible in the frame. */
  readonly colored?: boolean;
}

/** Mount the input under an owner that keeps the draft, and expose the test verbs. */
function mount(options: MountOptions = {}) {
  const { active, busy, hint, initialDraft = EMPTY_DRAFT, onEscape, yieldNavigation, colored = false } = options;
  const drafts: InputDraft[] = [];
  const onSubmit = mock((_text: string) => {});
  const onClearArmedChange = mock((_armed: boolean) => {});
  if (colored) chalk.level = FULL_COLOR;

  function Owner(): ReactElement {
    const [draft, setDraft] = useState<InputDraft>(initialDraft);
    const change = (next: InputDraft): void => {
      drafts.push(next);
      setDraft(next);
    };
    return (
      <ChatInput
        draft={draft}
        onDraftChange={change}
        onSubmit={onSubmit}
        width={WIDTH}
        theme={THEME}
        active={active}
        busy={busy}
        hint={hint}
        onEscape={onEscape}
        yieldNavigation={yieldNavigation}
        onClearArmedChange={onClearArmedChange}
      />
    );
  }

  const ui = render(<Owner />);
  /** The frame exactly as ink wrote it, escape codes included. */
  const rawFrame = (): string => ui.lastFrame() ?? "";
  /** Every frame row, without the escape codes a style may add. */
  const rows = (): string[] =>
    Bun.stripANSI(rawFrame())
      .split("\n")
      .map((row) => row.trimEnd());
  /** The rows between the two rule lines — the editor's own text rows. */
  const textRows = (): string[] => rows().slice(1, -1);
  /** The text the inverse cursor cell covers. */
  const cursorCell = (): string => inverseCell(rawFrame());
  /** How many inverse cells the frame draws, whatever they cover. */
  const inverseCells = (): number => rawFrame().split(INVERSE_ON).length - 1;
  const type = (input: string): void => {
    act(() => {
      ui.stdin.write(input);
    });
  };
  const editor = () => drafts.at(-1)?.editor ?? initialDraft.editor;
  return {
    ui,
    drafts,
    onSubmit,
    onClearArmedChange,
    rows,
    rawFrame,
    textRows,
    cursorCell,
    inverseCells,
    type,
    editor,
  };
}

describe("ChatInput empty focus cursor", () => {
  test("AC-1 draws the placeholder's first character inverse and the rest outside it", () => {
    const input = mount({ colored: true });
    expect(input.cursorCell()).toBe("T");
    expect(input.inverseCells()).toBe(1);
    // Every character of the placeholder survives the styling, and only the first cell is
    // inverted — so the rest of the hint is drawn outside the SGR 7 / SGR 27 pair.
    expect(input.textRows()).toEqual([`> ${PLACEHOLDER}`]);
    expect(input.rows()[0]).toBe(RULE);
    expect(input.rows().at(-1)).toBe(RULE);
  });

  test("AC-2 draws no inverse cell while the input is inactive", () => {
    const input = mount({ colored: true, active: false });
    expect(input.cursorCell()).toBe("");
    expect(input.inverseCells()).toBe(0);
    expect(input.textRows()).toEqual([`> ${PLACEHOLDER}`]);
  });

  test("AC-3 draws no inverse cell and no placeholder while a turn runs", () => {
    const input = mount({ colored: true, busy: true });
    expect(input.cursorCell()).toBe("");
    expect(input.inverseCells()).toBe(0);
    expect(input.textRows()).toEqual([">"]);
    expect(input.rawFrame()).not.toContain("Try");
  });

  test("AC-4 draws the hint's first character inverse", () => {
    const input = mount({ colored: true, hint: "esc again to clear" });
    expect(input.cursorCell()).toBe("e");
    expect(input.inverseCells()).toBe(1);
    expect(input.textRows()).toEqual(["> esc again to clear"]);
  });

  test("AC-5 leaves the nonempty draft's cursor cell where it was", () => {
    const input = mount({ colored: true, initialDraft: { editor: { text: "abc", cursor: 1 }, history: [] } });
    expect(input.cursorCell()).toBe("b");
    expect(input.inverseCells()).toBe(1);
    expect(input.textRows()).toEqual(["> abc"]);
  });
});

describe("ChatInput owner escape", () => {
  /** The input's whole clock: `now` for the window and the timers for its expiry. */
  function fakeClock() {
    const clock = makeFakeClock();
    _chatInputDeps.now = clock.now;
    _chatInputDeps.setTimeout = (callback, delayMs) => clock.setTimeout(callback, delayMs);
    _chatInputDeps.clearTimeout = (handle) => clock.clearTimeout(Number(handle));
    return clock;
  }
  /** Move the input's clock forward, letting any timer it passes fire inside React's scope. */
  function advance(clock: ReturnType<typeof fakeClock>, ms: number): Promise<void> {
    return Promise.resolve(
      act(async () => {
        await clock.advance(ms);
      }),
    );
  }

  test("AC-6 hands an escape to onEscape and never arms the clear", async () => {
    const clock = fakeClock();
    const onEscape = mock(() => {});
    const input = mount({ onEscape, initialDraft: { editor: { text: "abc", cursor: 3 }, history: [] } });
    input.type(ESCAPE);
    expect(onEscape).toHaveBeenCalledTimes(1);
    // No clear-arm: the owner's escape is the only thing an escape does.
    expect(input.onClearArmedChange).not.toHaveBeenCalled();
    await advance(clock, DOUBLE_ESCAPE_MS);
    input.type(ESCAPE);
    expect(onEscape).toHaveBeenCalledTimes(2);
    expect(input.editor().text).toBe("abc");
    expect(input.drafts).toHaveLength(0);
  });

  test("AC-7 hands an escape over even while the draft is empty", () => {
    const onEscape = mock(() => {});
    const input = mount({ onEscape });
    input.type(ESCAPE);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(input.drafts).toHaveLength(0);
    expect(input.textRows()).toEqual([`> ${PLACEHOLDER}`]);
  });

  test("AC-8 without onEscape two escapes in the window still clear the draft", async () => {
    const clock = fakeClock();
    const input = mount({ initialDraft: { editor: { text: "abc", cursor: 3 }, history: [] } });
    input.type(ESCAPE);
    expect(input.onClearArmedChange).toHaveBeenCalledWith(true);
    await advance(clock, DOUBLE_ESCAPE_MS);
    input.type(ESCAPE);
    expect(input.editor()).toEqual(EMPTY_EDITOR);
    expect(input.textRows()).toEqual([`> ${PLACEHOLDER}`]);
  });

  test("an open menu still owns the escape, so onEscape is not called", () => {
    const onEscape = mock(() => {});
    const input = mount({ onEscape, yieldNavigation: true });
    input.type(ESCAPE);
    expect(onEscape).not.toHaveBeenCalled();
    expect(input.drafts).toHaveLength(0);
  });

  test("hands the escape over while a turn runs, ahead of the busy early return", () => {
    // US-009's running-turn question card needs this: the clear-arm would have skipped the
    // key entirely, and the callback is asked before the busy check for that reason.
    const onEscape = mock(() => {});
    const input = mount({ onEscape, busy: true });
    input.type(ESCAPE);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(input.onClearArmedChange).not.toHaveBeenCalled();
  });
});
