/**
 * AskPrompt — the ask surface, and the model that measures it.
 *
 * `askPromptLayout` runs before the screen lays the card out, so every row the card draws has
 * to be a row the model counted at the card's own width. The head and the options are wrapped
 * by the model, but the elision label (`… 12 more lines`) and the sandbox note are short
 * strings that only look like one row: on a narrow card they wrap themselves, and a row that
 * wraps without being counted pushes a question line the card never reserved room for off the
 * screen — the frame clips what the model measured, not what it drew.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import type { ChatAskController, ChatPendingAsk } from "@/chat";
import { AskPrompt, type AskPromptLayout, askPromptLayout } from "@/tui/chat/AskPrompt";
import { displayWidth } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";

/** Colour off: the rows a frame carries are the plain characters. */
const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
/** Narrow enough that the elision label and the sandbox note wrap on their own. */
const NARROW = 12;

afterEach(() => {
  cleanup();
});

function fakeController(): ChatAskController {
  return {
    handle: () => {},
    pending: () => [],
    resolve: () => {},
    canRemember: () => true,
    answerQuestion: () => {},
    setMode: () => {},
    reset: () => {},
    onChange: () => () => {},
  };
}

const base = { sessionId: "s", turnId: "t1", at: "now", metadata: {} } as const;

const approval: ChatPendingAsk = {
  ...base,
  type: "approval_requested",
  requestId: "ask-1",
  tool: "Bash",
  command: "npm test",
  summary: "test",
  reason: "Run the tests",
  expiresAt: "later",
};

/** A question whose text is many more rows than a short screen can spare. */
function question(lines: number): ChatPendingAsk {
  return {
    ...base,
    type: "question",
    requestId: "q1",
    text: Array.from({ length: lines }, (_, index) => `line ${index}`).join("\n"),
    expiresAt: "later",
  };
}

function layoutOf(ask: ChatPendingAsk, budget: number, width = NARROW): AskPromptLayout {
  return askPromptLayout(ask, { width, canRemember: true, answer: "", budget, theme: THEME });
}

/** The rows the card draws at `width`, as the screen frames it. */
function drawn(layout: AskPromptLayout, ask: ChatPendingAsk, width = NARROW): string[] {
  const ui = render(
    <Box flexDirection="column" width={width}>
      <AskPrompt
        ask={ask}
        controller={fakeController()}
        layout={layout}
        answer=""
        onAnswerChange={() => {}}
        width={width}
      />
    </Box>,
  );
  return (ui.lastFrame() ?? "").split("\n");
}

/** The rows the card draws in the frame, escape codes and trailing padding removed. */
function frameRows(layout: AskPromptLayout, ask: ChatPendingAsk, width = NARROW): string[] {
  return drawn(layout, ask, width).map((row) => Bun.stripANSI(row).trimEnd());
}

/** Every row of a card flattened to one line, so a wrap does not hide a phrase. */
function flatten(lines: readonly string[]): string {
  return lines.join(" ").replace(/\s+/g, " ");
}

const everyRow = (layout: AskPromptLayout): readonly string[] => [...layout.head, ...layout.elision, ...layout.tail];

describe("AskPrompt narrow card measurement", () => {
  test("fits every kept row and the elision label to the card's width", () => {
    const layout = layoutOf(question(40), 20);
    for (const row of everyRow(layout)) expect(displayWidth(row)).toBeLessThanOrEqual(NARROW);
  });

  test("fits the sandbox note to the card's width", () => {
    const layout = layoutOf({ ...approval, unsandboxed: true }, 20);
    for (const row of everyRow(layout)) expect(displayWidth(row)).toBeLessThanOrEqual(NARROW);
    expect(flatten(layout.tail)).toContain("outside the sandbox");
  });

  test("counts the wrapped elision label in its rows", () => {
    const layout = layoutOf(question(40), 20);
    expect(layout.elision.length).toBeGreaterThan(1);
    expect(layout.rows).toBe(layout.head.length + layout.elision.length + layout.tail.length + layout.input);
    expect(layout.rows).toBeLessThanOrEqual(20);
  });

  test("draws exactly the rows it counted on a narrow question", () => {
    const ask = question(40);
    const layout = layoutOf(ask, 20);
    const rows = frameRows(layout, ask);
    expect(rows).toHaveLength(layout.rows);
  });

  test("keeps the question's first line and the answer box on a narrow question", () => {
    const ask = question(40);
    const layout = layoutOf(ask, 20);
    const rows = frameRows(layout, ask);
    expect(rows[0]).toBe("line 0");
    expect(rows.at(-1)).toStartWith(">");
  });

  test("draws exactly the rows it counted for an unsandboxed approval", () => {
    const ask: ChatPendingAsk = { ...approval, unsandboxed: true };
    const layout = layoutOf(ask, 20);
    const rows = frameRows(layout, ask);
    expect(rows).toHaveLength(layout.rows);
    expect(flatten(rows)).toContain("outside the sandbox");
  });

  test("a card that fits keeps every row and no elision label", () => {
    const layout = layoutOf(approval, 30);
    expect(layout.elided).toBe(0);
    expect(layout.elision).toEqual([]);
    expect(layout.rows).toBeLessThanOrEqual(30);
    expect(frameRows(layout, approval)).toHaveLength(layout.rows);
  });

  test("a wide card never wraps the elision label", () => {
    const layout = askPromptLayout(question(40), {
      width: 40,
      canRemember: true,
      answer: "",
      budget: 20,
      theme: THEME,
    });
    expect(layout.elision).toHaveLength(1);
    expect(frameRows(layout, question(40), 40)).toHaveLength(layout.rows);
  });

  test("an ASCII theme's elision label is measured at its own width", () => {
    const ascii: ChatTheme = resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 0 });
    const layout = askPromptLayout(question(40), {
      width: NARROW,
      canRemember: true,
      answer: "",
      budget: 20,
      theme: ascii,
    });
    for (const row of everyRow(layout)) expect(displayWidth(row)).toBeLessThanOrEqual(NARROW);
    expect(frameRows(layout, question(40))).toHaveLength(layout.rows);
  });
});
