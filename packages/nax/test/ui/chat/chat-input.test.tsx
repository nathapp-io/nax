/**
 * ChatInput — the controlled framed prompt.
 *
 * The harness mounts the input under a small owner that holds the `InputDraft`, exactly
 * as `ChatApp` does, so a submitted text reaches `history` the way it will in the screen
 * and a re-render can be observed. A colourless theme keeps every frame plain text, so a
 * row assertion is about the characters the terminal shows and nothing else; the cursor
 * tests raise chalk's level instead, because the inverse cell is the one part of a frame
 * that carries no text of its own.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeFakeClock } from "@test/helpers";
import chalk from "chalk";
import { cleanup, render } from "ink-testing-library";
import { act, type ReactElement, useState } from "react";
import {
  _chatInputDeps,
  ChatInput,
  type ChatInputHandle,
  DOUBLE_ESCAPE_MS,
  EMPTY_DRAFT,
  type InputDraft,
} from "@/tui/chat/ChatInput";
import { type EditorState, EMPTY_EDITOR } from "@/tui/chat/line-editor";
import { resolveChatTheme } from "@/tui/chat/theme";

/** Colour off: every token undefined, so every frame row is the plain characters. */
const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const WIDTH = 20;
const RULE = THEME.glyphs.rule.repeat(WIDTH);
const PLACEHOLDER = 'Try "explain how nax run picks a model" · / for commands';

/** The sequences ink parses into the keys the input owns. */
const RETURN = "\r";
const SHIFT_RETURN = "\x1b\r";
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";

/** Full colour, so ink surrounds the inverse cursor cell with the SGR 7 / SGR 27 pair. */
const FULL_COLOR = 3;
/** The SGR pair ink writes around an inverse cell. */
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
  readonly yieldNavigation?: boolean;
  readonly initialDraft?: InputDraft;
  /** Render with colour forced on, so the inverse cursor cell is visible in the frame. */
  readonly colored?: boolean;
}

/** Mount the input under an owner that keeps the draft, and expose the test verbs. */
function mount(options: MountOptions = {}) {
  const { active, busy, hint, yieldNavigation, initialDraft = EMPTY_DRAFT, colored = false } = options;
  const drafts: InputDraft[] = [];
  const onSubmit = mock((_text: string) => {});
  const onClearArmedChange = mock((_armed: boolean) => {});
  /** The handle the input publishes, so a case can drive the verbs the slash menu and the mention picker use. */
  const handle: { current: ChatInputHandle | undefined } = { current: undefined };
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
        yieldNavigation={yieldNavigation}
        handle={handle}
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
  const type = (input: string): void => {
    act(() => {
      ui.stdin.write(input);
    });
  };
  /** Several keypresses delivered before the owner can re-render — one React batch. */
  const typeBatch = (...inputs: readonly string[]): void => {
    act(() => {
      for (const input of inputs) ui.stdin.write(input);
    });
  };
  const editor = (): EditorState => drafts.at(-1)?.editor ?? initialDraft.editor;
  return {
    ui,
    drafts,
    onSubmit,
    onClearArmedChange,
    handle,
    rows,
    rawFrame,
    textRows,
    cursorCell,
    type,
    typeBatch,
    editor,
  };
}

describe("ChatInput frame", () => {
  test("AC-1 draws a rule line above and below the editor at the given width", () => {
    const input = mount();
    const rows = input.rows();
    expect(rows[0]).toBe(RULE);
    expect(rows.at(-1)).toBe(RULE);
  });

  test("AC-2 shows the prompt marker and the placeholder in the middle row", () => {
    const input = mount();
    expect(input.textRows()).toEqual([`> ${PLACEHOLDER}`]);
  });

  test("AC-3 shows the hint instead of the placeholder", () => {
    const input = mount({ hint: "tell nax what to do instead" });
    expect(input.textRows()).toEqual(["> tell nax what to do instead"]);
  });

  test("AC-14 indents the second text row by two spaces", () => {
    const input = mount();
    input.type("a");
    input.type(SHIFT_RETURN);
    input.type("b");
    expect(input.textRows()).toEqual(["> a", "  b"]);
  });
});

describe("ChatInput submit", () => {
  test("AC-4 submits the typed text on return", () => {
    const input = mount();
    input.type("hello");
    input.type(RETURN);
    expect(input.onSubmit).toHaveBeenCalledWith("hello");
  });

  test("AC-5 empties the input after a submit", () => {
    const input = mount();
    input.type("hello");
    input.type(RETURN);
    expect(input.editor()).toEqual(EMPTY_EDITOR);
    expect(input.textRows()).toEqual([`> ${PLACEHOLDER}`]);
  });

  test("AC-6 does not submit whitespace-only text", () => {
    const input = mount();
    input.type("   ");
    input.type(RETURN);
    expect(input.onSubmit).not.toHaveBeenCalled();
    expect(input.editor().text).toBe("   ");
  });

  test("AC-7 keeps the text and does not submit while busy", () => {
    const input = mount({ busy: true });
    input.type("hello");
    input.type(RETURN);
    expect(input.onSubmit).not.toHaveBeenCalled();
    expect(input.textRows()).toEqual(["> hello"]);
  });

  test("AC-8 submits a slash command while busy", () => {
    const input = mount({ busy: true });
    input.type("/cost");
    input.type(RETURN);
    expect(input.onSubmit).toHaveBeenCalledWith("/cost");
  });
});

describe("ChatInput history", () => {
  /** Submit `texts` through the real keys, so the history is the one the input built. */
  function submitAll(input: ReturnType<typeof mount>, texts: readonly string[]): void {
    for (const text of texts) {
      input.type(text);
      input.type(RETURN);
    }
  }

  test("AC-9 recalls the last submitted text on the first up arrow", () => {
    const input = mount();
    submitAll(input, ["one", "two"]);
    input.type(UP);
    expect(input.textRows()).toEqual(["> two"]);
  });

  test("AC-10 walks one entry older on the second up arrow", () => {
    const input = mount();
    submitAll(input, ["one", "two"]);
    input.type(UP);
    input.type(UP);
    expect(input.textRows()).toEqual(["> one"]);
  });

  test("AC-11 restores the empty draft past the newest entry", () => {
    const input = mount();
    submitAll(input, ["one", "two"]);
    input.type(UP);
    input.type(UP);
    expect(input.textRows()).toEqual(["> one"]);
    input.type(DOWN);
    input.type(DOWN);
    expect(input.editor()).toEqual(EMPTY_EDITOR);
    expect(input.textRows()).toEqual([`> ${PLACEHOLDER}`]);
  });

  test("AC-12 restores the text typed before browsing", () => {
    const input = mount({ initialDraft: { editor: EMPTY_EDITOR, history: ["one", "two"] } });
    input.type("dra");
    input.type(UP);
    expect(input.textRows()).toEqual(["> two"]);
    input.type(DOWN);
    expect(input.textRows()).toEqual(["> dra"]);
  });

  test("F2 a shifted arrow leaves the draft alone — the viewport owns it", () => {
    const draft = { text: "my draft", cursor: 8 };
    const input = mount({ initialDraft: { editor: draft, history: ["hello"] } });
    input.type(SHIFT_UP);
    input.type(SHIFT_DOWN);
    expect(input.drafts).toHaveLength(0);
    expect(input.textRows()).toEqual(["> my draft"]);
    // The bare arrows would have browsed it, so the draft is genuinely untouched, not stale.
    input.type(UP);
    expect(input.textRows()).toEqual(["> hello"]);
  });
});

describe("ChatInput rows", () => {
  /** A draft of `count` one-token lines with the cursor on the last one. */
  function linesDraft(count: number): InputDraft {
    const text = Array.from({ length: count }, (_unused, index) => `${index + 1}`).join("\n");
    return { editor: { text, cursor: Array.from(text).length }, history: [] };
  }

  test("AC-13 shows eight text rows, the window following the cursor's row", () => {
    const input = mount({ initialDraft: linesDraft(10) });
    const rows = input.rows();
    expect(rows[0]).toBe(RULE);
    expect(rows.at(-1)).toBe(RULE);
    expect(input.textRows()).toHaveLength(8);
    expect(input.textRows().some((row) => row.trim() === "10")).toBe(true);
    expect(input.textRows().some((row) => row.trim() === "1")).toBe(false);
  });
});

describe("ChatInput clear arm", () => {
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

  test("AC-15 the first escape arms the clear and keeps the text", () => {
    fakeClock();
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    expect(input.onClearArmedChange).toHaveBeenCalledWith(true);
    expect(input.textRows()).toEqual(["> abc"]);
  });

  test("AC-16 a second escape within the window empties the input", async () => {
    const clock = fakeClock();
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    await advance(clock, DOUBLE_ESCAPE_MS);
    input.type(ESCAPE);
    expect(input.editor()).toEqual(EMPTY_EDITOR);
  });

  test("AC-17 the clearing escape reports the disarm", async () => {
    const clock = fakeClock();
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    await advance(clock, DOUBLE_ESCAPE_MS);
    input.type(ESCAPE);
    expect(input.onClearArmedChange).toHaveBeenLastCalledWith(false);
  });

  test("AC-18 a second escape past the window keeps the text", async () => {
    const clock = fakeClock();
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    const armed = [...input.onClearArmedChange.mock.calls];
    await advance(clock, DOUBLE_ESCAPE_MS + 1);
    input.type(ESCAPE);
    expect(armed).toEqual([[true]]);
    expect(input.textRows()).toEqual(["> abc"]);
    expect(input.editor().text).toBe("abc");
  });

  test("reports the disarm when a submit clears the armed state", () => {
    fakeClock();
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    input.type(RETURN);
    expect(input.onSubmit).toHaveBeenCalledWith("abc");
    expect(input.onClearArmedChange.mock.calls).toEqual([[true], [false]]);
  });

  test("reports the disarm when the arm expires", async () => {
    const clock = fakeClock();
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    await advance(clock, DOUBLE_ESCAPE_MS + 1);
    expect(input.onClearArmedChange.mock.calls).toEqual([[true], [false]]);
    expect(input.editor().text).toBe("abc");
    input.type(ESCAPE);
    expect(input.onClearArmedChange).toHaveBeenLastCalledWith(true);
  });

  test("arms again rather than clearing after the window expired", async () => {
    const clock = fakeClock();
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    await advance(clock, DOUBLE_ESCAPE_MS + 1);
    input.type(ESCAPE);
    input.type(ESCAPE);
    expect(input.editor()).toEqual(EMPTY_EDITOR);
  });
});

describe("ChatInput cursor position", () => {
  /** A cursor placed by the owner, drawn with colour on so the inverse cell is readable. */
  function at(text: string, cursor: number) {
    return mount({ colored: true, initialDraft: { editor: { text, cursor }, history: [] } });
  }

  test("sits after a double-width character rather than on it", () => {
    const input = at("日", 1);
    expect(input.textRows()).toEqual(["> 日"]);
    expect(input.cursorCell()).toBe(" ");
  });

  test("sits before the character that follows an emoji", () => {
    const input = at("a😀b", 2);
    expect(input.textRows()).toEqual(["> a😀b"]);
    expect(input.cursorCell()).toBe("b");
  });

  test("counts a tab as the two columns it is drawn as", () => {
    const input = at("a\tb", 2);
    expect(input.textRows()).toEqual(["> a  b"]);
    expect(input.cursorCell()).toBe("b");
  });

  test("ignores a control byte it strips from the row", () => {
    const input = at("a\u0007b", 2);
    expect(input.textRows()).toEqual(["> ab"]);
    expect(input.cursorCell()).toBe("b");
  });

  test("holds one cell inside a double-width character's neighbour", () => {
    const input = at("日本", 1);
    expect(input.cursorCell()).toBe("本");
  });

  test("treats a joined emoji as one cell rather than its code points", () => {
    // 👩 ZWJ 💻 draws as a single two-column cluster; the cursor after it is in front of b.
    const input = at("👩\u200d💻b", 3);
    expect(input.textRows()).toEqual(["> 👩\u200d💻b"]);
    expect(input.cursorCell()).toBe("b");
  });

  test("ends a joined emoji row with the cursor after it", () => {
    const input = at("👩\u200d💻", 3);
    expect(input.cursorCell()).toBe(" ");
  });

  test("F5 draws exactly one cursor in a draft taller than its window", () => {
    // 2,400 characters at this width is 25 physical rows, so the input windows eight of
    // them; the cursor sits on the second and must be the only inverted cell in the frame.
    const input = at("v".repeat(2400), 100);
    const inverseCells = input.rawFrame().split(INVERSE_ON).length - 1;
    expect(inverseCells).toBe(1);
    expect(input.cursorCell()).toBe("v");
  });
});

describe("ChatInput batching", () => {
  test("keeps every key of one batch, not just the last", () => {
    const input = mount();
    input.typeBatch("a", "b", "c");
    expect(input.textRows()).toEqual(["> abc"]);
    expect(input.editor()).toEqual({ text: "abc", cursor: 3 });
  });

  test("keeps a submit inside a batch and the text typed after it", () => {
    const input = mount();
    input.typeBatch("hi", RETURN, "x");
    expect(input.onSubmit).toHaveBeenCalledWith("hi");
    expect(input.textRows()).toEqual(["> x"]);
  });
});

describe("ChatInput handle", () => {
  test("AC-1 an edit writes the text and leaves the cursor where the caller put it", () => {
    const input = mount();
    act(() => {
      input.handle.current?.edit({ text: "abc", cursor: 1 });
    });
    expect(input.textRows()).toEqual(["> abc"]);
    input.type("X");
    expect(input.textRows()).toEqual(["> aXbc"]);
  });

  test("AC-23 complete still writes the text with the cursor at its end", () => {
    const input = mount();
    act(() => {
      input.handle.current?.complete("abc");
    });
    input.type("X");
    expect(input.textRows()).toEqual(["> abcX"]);
  });

  test("AC-24 submit still hands the line to the owner's onSubmit", () => {
    const input = mount();
    act(() => {
      input.handle.current?.submit("hello");
    });
    expect(input.onSubmit).toHaveBeenCalledWith("hello");
    expect(input.textRows()).toEqual([`> ${PLACEHOLDER}`]);
  });
});

describe("ChatInput key ownership", () => {
  test("AC-19 changes nothing while inactive", () => {
    const input = mount({ active: false });
    input.type("hello");
    input.type(RETURN);
    expect(input.onSubmit).not.toHaveBeenCalled();
    expect(input.drafts).toHaveLength(0);
    expect(input.textRows()).toEqual([`> ${PLACEHOLDER}`]);
  });

  test("AC-20 yields return and the arrows to the slash menu", () => {
    const input = mount({ yieldNavigation: true, initialDraft: { editor: EMPTY_EDITOR, history: ["one"] } });
    input.type("x");
    input.type(UP);
    expect(input.textRows()).toEqual(["> x"]);
    input.type(RETURN);
    expect(input.onSubmit).not.toHaveBeenCalled();
  });
});

describe("ChatInput edges", () => {
  test("an unmocked clock still clears on two quick escapes", () => {
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    input.type(ESCAPE);
    expect(input.editor()).toEqual(EMPTY_EDITOR);
  });

  test("ignores escape while a turn runs and while the input is empty", () => {
    const busy = mount({ busy: true });
    busy.type("abc");
    busy.type(ESCAPE);
    expect(busy.onClearArmedChange).not.toHaveBeenCalled();
    expect(busy.textRows()).toEqual(["> abc"]);

    const empty = mount();
    empty.type(ESCAPE);
    expect(empty.onClearArmedChange).not.toHaveBeenCalled();
    expect(empty.drafts).toHaveLength(0);
  });

  test("does not walk past the oldest history entry", () => {
    const input = mount({ initialDraft: { editor: EMPTY_EDITOR, history: ["one", "two"] } });
    input.type(UP);
    input.type(UP);
    input.type(UP);
    expect(input.textRows()).toEqual(["> one"]);
  });

  test("does not recall history from a row that is neither the first nor the last", () => {
    const twoRows = (cursor: number) => mount({ initialDraft: { editor: { text: "a\nb", cursor }, history: ["one"] } });
    const lastRow = twoRows(3);
    lastRow.type(UP);
    expect(lastRow.textRows()).toEqual(["> a", "  b"]);
    const firstRow = twoRows(1);
    firstRow.type(DOWN);
    expect(firstRow.textRows()).toEqual(["> a", "  b"]);
  });

  test("does not step down while not browsing", () => {
    const input = mount({ initialDraft: { editor: EMPTY_EDITOR, history: ["one"] } });
    input.type(DOWN);
    expect(input.textRows()).toEqual([`> ${PLACEHOLDER}`]);
  });

  test("drops the browse position once the recalled text is edited", () => {
    const input = mount({ initialDraft: { editor: EMPTY_EDITOR, history: ["one", "two"] } });
    input.type(UP);
    input.type("!");
    input.type(DOWN);
    expect(input.textRows()).toEqual(["> two!"]);
  });
});
