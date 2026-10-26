/**
 * ChatInput — the controlled framed prompt.
 *
 * The harness mounts the input under a small owner that holds the `InputDraft`, exactly
 * as `ChatApp` does, so a submitted text reaches `history` the way it will in the screen
 * and a re-render can be observed. A colourless theme keeps every frame plain text, so a
 * row assertion is about the characters the terminal shows and nothing else.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act, type ReactElement, useState } from "react";
import { _chatInputDeps, ChatInput, DOUBLE_ESCAPE_MS, EMPTY_DRAFT, type InputDraft } from "@/tui/chat/ChatInput";
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

const originalNow = _chatInputDeps.now;
afterEach(() => {
  cleanup();
  _chatInputDeps.now = originalNow;
});

interface MountOptions {
  readonly active?: boolean;
  readonly busy?: boolean;
  readonly hint?: string;
  readonly yieldNavigation?: boolean;
  readonly initialDraft?: InputDraft;
}

/** Mount the input under an owner that keeps the draft, and expose the test verbs. */
function mount(options: MountOptions = {}) {
  const { active, busy, hint, yieldNavigation, initialDraft = EMPTY_DRAFT } = options;
  const drafts: InputDraft[] = [];
  const onSubmit = mock((_text: string) => {});
  const onClearArmedChange = mock((_armed: boolean) => {});

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
        onClearArmedChange={onClearArmedChange}
      />
    );
  }

  const ui = render(<Owner />);
  /** Every frame row, without the escape codes a style may add. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  /** The rows between the two rule lines — the editor's own text rows. */
  const textRows = (): string[] => rows().slice(1, -1);
  const type = (input: string): void => {
    act(() => {
      ui.stdin.write(input);
    });
  };
  const editor = (): EditorState => drafts.at(-1)?.editor ?? initialDraft.editor;
  return { ui, drafts, onSubmit, onClearArmedChange, rows, textRows, type, editor };
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
  /** A clock the test moves by hand, so the double-escape window is exact. */
  function fixedClock(start: number) {
    let current = start;
    _chatInputDeps.now = () => current;
    return { advance: (ms: number) => (current += ms) };
  }

  test("AC-15 the first escape arms the clear and keeps the text", () => {
    fixedClock(1000);
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    expect(input.onClearArmedChange).toHaveBeenCalledWith(true);
    expect(input.textRows()).toEqual(["> abc"]);
  });

  test("AC-16 a second escape within the window empties the input", () => {
    const clock = fixedClock(1000);
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    clock.advance(DOUBLE_ESCAPE_MS);
    input.type(ESCAPE);
    expect(input.editor()).toEqual(EMPTY_EDITOR);
  });

  test("AC-17 the clearing escape reports the disarm", () => {
    const clock = fixedClock(1000);
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    clock.advance(DOUBLE_ESCAPE_MS);
    input.type(ESCAPE);
    expect(input.onClearArmedChange).toHaveBeenLastCalledWith(false);
  });

  test("AC-18 a second escape past the window keeps the text", () => {
    const clock = fixedClock(1000);
    const input = mount();
    input.type("abc");
    input.type(ESCAPE);
    const armed = [...input.onClearArmedChange.mock.calls];
    clock.advance(DOUBLE_ESCAPE_MS + 1);
    input.type(ESCAPE);
    expect(armed).toEqual([[true]]);
    expect(input.textRows()).toEqual(["> abc"]);
    expect(input.onClearArmedChange).not.toHaveBeenCalledWith(false);
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
