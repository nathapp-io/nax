import { describe, expect, test } from "bun:test";
import { type ChoiceQuestion, formatChoiceAnswers } from "@nathapp/nax-agent";
import type { ChatPendingAsk, HostChoiceAsk } from "@/chat";
import { askCardLayout, measureAskCard } from "@/tui/chat/AskCard";
import { type AskCardChoiceQuestion, askCardModel } from "@/tui/chat/ask-card";
import { EMPTY_DRAFT } from "@/tui/chat/ChatInput";
import { type ChoiceState, initialChoiceState } from "@/tui/chat/choice-question";
import { choiceQuestionLayout } from "@/tui/chat/choice-question-layout";
import { displayWidth, plainText, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";

/** Colour off: every row is the plain characters, so a row can be compared whole. */
const THEME: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 0 });
/** Wide enough that no row in these cases wraps. */
const WIDTH = 80;
/** An expiry that does not parse, so the countdown is the one row `expires in 0:00`. */
const EXPIRES_AT = "later";
/** The instant the card's clock is read at; the model reads none. */
const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
/** "Unlimited": a budget no card can reach, so nothing is withheld. */
const UNLIMITED = Number.POSITIVE_INFINITY;
/** The pointer row's prefix, and the blank columns that keep an option's boxes in column. */
const POINTER = `${THEME.glyphs.pointer} `;
const BLANK_POINTER = " ".repeat(displayWidth(THEME.glyphs.pointer) + 1);

type ChatQuestion = Extract<ChatPendingAsk, { type: "question" }>;

/** One choice question as the shared contract carries it. */
function question(overrides: Partial<ChoiceQuestion> = {}): ChoiceQuestion {
  return {
    header: "Runner",
    question: "Which runner?",
    options: [{ label: "bun" }, { label: "vitest" }],
    multiSelect: false,
    allowOther: true,
    required: true,
    ...overrides,
  };
}

/** One question ask, as the session raises it. */
function ask(questions: readonly ChoiceQuestion[], prompt?: string): ChatQuestion {
  return {
    type: "question",
    sessionId: "s1",
    turnId: "t1",
    at: "2026-01-01T00:00:00.000Z",
    metadata: {},
    requestId: "q1",
    text: "the rendered text the card does not draw",
    expiresAt: EXPIRES_AT,
    questions,
    ...(prompt === undefined ? {} : { prompt }),
  };
}

/** The choice-question model the card draws, built the way the screen builds it. */
function model(questions: readonly ChoiceQuestion[], prompt?: string): AskCardChoiceQuestion {
  const built = askCardModel(ask(questions, prompt), { canRemember: false, entries: [] });
  if (built.kind !== "choice-question") throw new Error(`expected a choice-question, got ${built.kind}`);
  return built;
}

/** A card's state on its first tab: nothing chosen, nothing open. */
function stateFor(card: AskCardChoiceQuestion, overrides: Partial<ChoiceState> = {}): ChoiceState {
  return { ...initialChoiceState(card.questions), ...overrides };
}

/** Every row the card draws, in the order it draws them. */
function rows(layout: ReturnType<typeof choiceQuestionLayout>): string[] {
  return [...layout.head, ...layout.middle, ...layout.tail].map(plainText);
}

/** The card's rows at one width and budget, in the plain theme. */
function draw(card: AskCardChoiceQuestion, state: ChoiceState, budget = UNLIMITED, width = WIDTH) {
  return choiceQuestionLayout(card, state, { width, budget, theme: THEME, expiresAt: EXPIRES_AT, nowMs: NOW_MS });
}

/** What the card measures at one width. */
function measure(card: AskCardChoiceQuestion, width = WIDTH) {
  return measureAskCard(card, { width, theme: THEME, answer: EMPTY_DRAFT, expiresAt: EXPIRES_AT, nowMs: NOW_MS });
}

/** The options a twelve-row list is built from: enough to be windowed by any short budget. */
const MANY: readonly ChoiceQuestion[] = [
  question({
    allowOther: false,
    options: Array.from({ length: 12 }, (_unused, index) => ({ label: `option ${index + 1}` })),
  }),
];

describe("choiceQuestionLayout tab strip", () => {
  test("AC-3: two questions draw a tab strip naming both headers and Submit", () => {
    const card = model([
      question({ header: "Runner" }),
      question({ header: "Scope", question: "Which scope?", options: [{ label: "unit" }, { label: "e2e" }] }),
    ]);
    const frame = rows(draw(card, stateFor(card))).join("\n");
    expect(frame).toContain("[Runner]");
    expect(frame).toContain("[Scope]");
    expect(frame).toContain("[Submit]");
  });

  test("AC-3: one question draws no tab strip", () => {
    const card = model([question({ header: "Runner" })]);
    const frame = rows(draw(card, stateFor(card))).join("\n");
    expect(frame).not.toContain("[Submit]");
    expect(frame).not.toContain("[Runner]");
  });
});

describe("choiceQuestionLayout option rows", () => {
  test("AC-4: single-select rows draw the cursor pointer and (*) / ( )", () => {
    const card = model([question({ allowOther: false })]);
    const drawn = rows(draw(card, stateFor(card, { selected: [[0]], cursor: 1 })));
    expect(drawn).toContain(`${BLANK_POINTER}(*) 1. bun`);
    expect(drawn).toContain(`${POINTER}( ) 2. vitest`);
  });

  test("AC-4: multi-select rows draw the cursor pointer and [x] / [ ]", () => {
    const card = model([question({ multiSelect: true, allowOther: false })]);
    const drawn = rows(draw(card, stateFor(card, { selected: [[0]], cursor: 1 })));
    expect(drawn).toContain(`${BLANK_POINTER}[x] 1. bun`);
    expect(drawn).toContain(`${POINTER}[ ] 2. vitest`);
  });

  test("AC-5: an option's description follows its label in the muted colour, cut to the width", () => {
    const card = model([
      question({
        allowOther: false,
        options: [
          { label: "bun", description: "the fast runtime" },
          { label: "vitest", description: "x".repeat(200) },
        ],
      }),
    ]);
    const drawn = draw(card, stateFor(card), UNLIMITED, 40);
    const optionRows = drawn.middle.map(plainText);
    expect(optionRows[0]).toBe(`${POINTER}( ) 1. bun  the fast runtime`);
    const description = drawn.middle[0]?.find((span) => span.text === "  the fast runtime");
    expect(description?.color).toBe("muted");
    // The wide description is cut, so the row is exactly the width and ends in the ellipsis.
    expect(displayWidth(optionRows[1] ?? "")).toBe(40);
    expect(optionRows[1]?.endsWith(THEME.glyphs.ellipsis)).toBe(true);
  });

  test("AC-6: a last Other... row shows the stored other, and is absent when allowOther is false", () => {
    const allowed = model([question({ allowOther: true })]);
    const listed = draw(allowed, stateFor(allowed)).middle.map(plainText);
    expect(listed.at(-1)).toBe(`${BLANK_POINTER}Other...`);
    const stored = draw(allowed, stateFor(allowed, { other: ["neither of those"] })).middle.map(plainText);
    expect(stored.at(-1)).toBe(`${BLANK_POINTER}Other... neither of those`);

    const denied = model([question({ allowOther: false })]);
    const deniedRows = draw(denied, stateFor(denied)).middle.map(plainText);
    expect(deniedRows.some((row) => row.includes("Other..."))).toBe(false);
  });
});

describe("choiceQuestionLayout window", () => {
  test("AC-7: a waist-high budget keeps the cursor row and marks what it withholds", () => {
    const card = model(MANY);
    const budget = draw(card, stateFor(card)).rows - 6;
    const atTop = draw(card, stateFor(card), budget);
    const topRows = atTop.middle.map(plainText);
    expect(atTop.rows).toBeLessThanOrEqual(budget);
    expect(topRows.some((row) => row.includes(`${POINTER}( ) 1. option 1`))).toBe(true);
    expect(topRows.at(-1)).toContain("more below");
    expect(topRows[0]).not.toContain("more above");

    const atLast = draw(card, stateFor(card, { cursor: 11 }), budget);
    const lastRows = atLast.middle.map(plainText);
    expect(atLast.rows).toBeLessThanOrEqual(budget);
    expect(lastRows.some((row) => row.includes("12. option 12"))).toBe(true);
    expect(lastRows[0]).toContain("more above");
    expect(lastRows.at(-1)).not.toContain("more below");
  });

  test("AC-7: withheld option rows are what elided counts", () => {
    const card = model(MANY);
    const full = draw(card, stateFor(card));
    expect(full.elided).toBe(0);
    const windowed = draw(card, stateFor(card), full.rows - 6);
    expect(windowed.elided).toBe(full.middle.length - windowed.middle.filter((row) => !isMarker(row)).length);
    expect(windowed.elided).toBeGreaterThan(0);
  });
});

/** Whether a drawn row is one of the window's markers rather than an option. */
function isMarker(row: StyledLine): boolean {
  const text = plainText(row);
  return text.includes("more above") || text.includes("more below");
}

describe("choiceQuestionLayout minimum", () => {
  test("AC-8: the minimum is never more than the card draws, and it is drawn whole there", () => {
    const card = model([question({ allowOther: false })]);
    const measurement = measure(card);
    expect(measurement.minimum).toBeLessThanOrEqual(measurement.desired);
    const fitted = draw(card, stateFor(card), measurement.minimum);
    expect(fitted.rows).toBeLessThanOrEqual(measurement.minimum);
    expect(fitted.rows).toBe(measurement.desired);
    expect(fitted.elided).toBe(0);
  });

  test("AC-8: at the measured minimum the question, one option, the hint and the countdown survive", () => {
    const card = model([question({ question: "word ".repeat(60).trim(), allowOther: true })], "pick one");
    const measurement = measure(card, 40);
    const fitted = draw(card, stateFor(card), measurement.minimum, 40);
    expect(fitted.rows).toBeLessThanOrEqual(measurement.minimum);

    const drawn = rows(fitted);
    const frame = drawn.join("\n");
    // The question is one row, cut to the width and marked with the ellipsis.
    const questionRow = drawn.find((row) => row.startsWith("word word"));
    expect(questionRow).toBeDefined();
    expect(questionRow?.endsWith(THEME.glyphs.ellipsis)).toBe(true);
    // One option row, the hint, the countdown and the frame's rules.
    expect(frame).toContain("1. bun");
    expect(frame).toContain("esc");
    expect(frame).toContain("expires in");
    expect(drawn[0]).toBe(THEME.glyphs.rule.repeat(40));
    expect(drawn.at(-1)).toBe(THEME.glyphs.rule.repeat(40));
  });
});

describe("choiceQuestionLayout review step", () => {
  test("AC-9: the review step lists each header with its formatChoiceAnswers line", () => {
    const questions: readonly [ChoiceQuestion, ChoiceQuestion] = [
      question({ header: "Runner" }),
      question({ header: "Scope", question: "Which scope?", options: [{ label: "unit" }, { label: "e2e" }] }),
    ];
    const card = model(questions);
    const drawn = rows(draw(card, stateFor(card, { review: true, selected: [[1], [0]] })));
    expect(drawn).toContain("Runner");
    expect(drawn).toContain(formatChoiceAnswers([questions[0]], [{ selected: [1] }]));
    expect(drawn).toContain("Scope");
    expect(drawn).toContain(formatChoiceAnswers([questions[1]], [{ selected: [0] }]));
  });
});

describe("measureAskCard choice-question", () => {
  test("AC-10: desired is the largest unlimited draw over both tabs and the review step", () => {
    const card = model([
      question({ header: "Runner", options: [{ label: "bun" }, { label: "vitest" }, { label: "node" }] }),
      question({ header: "Scope", question: "Which scope?", options: [{ label: "unit" }, { label: "e2e" }] }),
    ]);
    const state = stateFor(card);
    const draws = [
      draw(card, { ...state, tab: 0 }).rows,
      draw(card, { ...state, tab: 1 }).rows,
      draw(card, { ...state, review: true }).rows,
    ];
    const measurement = measure(card);
    expect(measurement.desired).toBe(Math.max(...draws));
    expect(measurement.elided).toBe(0);
    expect(measurement.marker).toBe(0);
  });

  test("askCardLayout delegates the kind: rows as head/middle/tail, no input, elided counted", () => {
    const card = model(MANY);
    const layout = askCardLayout(card, {
      width: WIDTH,
      budget: 12,
      theme: THEME,
      answer: EMPTY_DRAFT,
      expiresAt: EXPIRES_AT,
      nowMs: NOW_MS,
    });
    expect(layout.input).toBe(0);
    expect(layout.inputMaxRows).toBe(0);
    expect(layout.rows).toBe(layout.head.length + layout.middle.length + layout.tail.length);
    expect(layout.rows).toBeLessThanOrEqual(12);
    expect(layout.elided).toBeGreaterThan(0);
    // The rules frame the card, the options live between them and the countdown closes it.
    const rule = THEME.glyphs.rule.repeat(WIDTH);
    expect(layout.head.map(plainText)[0]).toBe(rule);
    expect(layout.middle.map(plainText).some((row) => row.includes("1. option 1"))).toBe(true);
    expect(layout.tail.map(plainText)).toContain("expires in 0:00");
    expect(layout.tail.map(plainText).at(-1)).toBe(rule);
  });
});

test("a host choice ask keeps its own card and measures as one", () => {
  const choice: HostChoiceAsk = {
    type: "host_choice",
    requestId: "host-choice-1",
    tool: "nax-close",
    summary: "Quit?",
    reason: "Tasks are running",
    fallback: "stay",
    at: "2026-01-01T00:00:00.000Z",
    expiresAt: EXPIRES_AT,
    choices: [
      { id: "stop", label: "Quit and stop them" },
      { id: "stay", label: "Stay in chat" },
    ],
  };
  const built = askCardModel(choice, { canRemember: false, entries: [] });
  expect(built.kind).toBe("choice");
  const layout = askCardLayout(built, {
    width: WIDTH,
    budget: 20,
    theme: THEME,
    answer: EMPTY_DRAFT,
    expiresAt: choice.expiresAt,
    nowMs: NOW_MS,
  });
  expect(layout.middle).toEqual([]);
});
