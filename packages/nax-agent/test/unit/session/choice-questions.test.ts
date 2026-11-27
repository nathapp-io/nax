/**
 * US-001: the shared choice-question contract. Pure parsing, validation and
 * rendering; nothing here touches a session.
 */
import { describe, expect, test } from "bun:test";
import type { ChoiceAnswer, ChoiceAskResult, ChoiceQuestion } from "@nathapp/nax-agent";
import * as entry from "@nathapp/nax-agent";
import {
  CHOICE_HEADER_MAX_CHARS,
  CHOICE_MAX_QUESTIONS,
  type ChoiceOption,
  formatChoiceAnswers,
  parseChoiceQuestions,
  renderChoiceQuestionsText,
  validateChoiceAnswers,
} from "#src/session/choice-questions";

const LIMITS = { maxOptions: 8, allowOther: true };

function option(label: string, description?: string): ChoiceOption {
  return description === undefined ? { label } : { label, description };
}

function question(overrides: Partial<ChoiceQuestion> = {}): ChoiceQuestion {
  return {
    header: "Runner",
    question: "Runner?",
    options: [option("bun"), option("vitest")],
    multiSelect: false,
    allowOther: true,
    required: true,
    ...overrides,
  };
}

/** The reason of a rejected parse; fails the test when the parse succeeded. */
function reason(input: unknown, limits: { maxOptions: number; allowOther: boolean } = LIMITS): string {
  const result = parseChoiceQuestions(input, limits);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected the parse to fail");
  return result.reason;
}

/** The questions of an accepted parse; fails the test when the parse was rejected. */
function accepted(
  input: unknown,
  limits: { maxOptions: number; allowOther: boolean } = LIMITS,
): readonly ChoiceQuestion[] {
  const result = parseChoiceQuestions(input, limits);
  if (!result.ok) throw new Error(`expected the parse to succeed, got: ${result.reason}`);
  return result.questions;
}

function labels(...names: string[]): ChoiceOption[] {
  return names.map((name) => option(name));
}

describe("parseChoiceQuestions", () => {
  test("parses one question and defaults multiSelect, allowOther and required", () => {
    const questions = accepted([
      { question: "Runner?", header: "Runner", options: [{ label: "bun" }, { label: "vitest" }] },
    ]);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toEqual({
      header: "Runner",
      question: "Runner?",
      options: [{ label: "bun" }, { label: "vitest" }],
      multiSelect: false,
      allowOther: true,
      required: true,
    });
  });

  test("copies allowOther from the limits and keeps a description", () => {
    const questions = accepted(
      [{ header: "Checks", question: "Which checks?", options: [option("lint", "static"), option("tests")] }],
      { maxOptions: 8, allowOther: false },
    );
    expect(questions[0]?.allowOther).toBe(false);
    expect(questions[0]?.options[0]).toEqual({ label: "lint", description: "static" });
    expect(questions[0]?.options[1]).toEqual({ label: "tests" });
  });

  test("keeps an explicit multiSelect", () => {
    const questions = accepted([
      { header: "Checks", question: "Which checks?", multiSelect: true, options: labels("lint", "tests") },
    ]);
    expect(questions[0]?.multiSelect).toBe(true);
  });

  test("rejects an empty array and more than CHOICE_MAX_QUESTIONS questions", () => {
    expect(CHOICE_MAX_QUESTIONS).toBe(4);
    expect(reason([])).toContain("got 0");
    const five = Array.from({ length: 5 }, () => ({
      question: "Runner?",
      header: "Runner",
      options: labels("bun", "vitest"),
    }));
    expect(reason(five)).toContain("got 5");
  });

  test("rejects a non-array input", () => {
    const notAnArray: unknown = { questions: [] };
    expect(reason(notAnArray)).toContain("questions");
  });

  test("names questions[0].options when a question has one option", () => {
    const reasonText = reason([{ question: "Runner?", header: "Runner", options: labels("bun") }]);
    expect(reasonText).toContain("questions[0].options");
  });

  test("names questions[0].options when a question has more options than the limit", () => {
    const tooMany = labels("a", "b", "c", "d", "e", "f", "g", "h", "i");
    const reasonText = reason([{ question: "Runner?", header: "Runner", options: tooMany }]);
    expect(reasonText).toContain("questions[0].options");
  });

  test("rejects two labels that differ only in case", () => {
    const reasonText = reason([{ question: "Runner?", header: "Runner", options: labels("Bun", "bun") }]);
    expect(reasonText).toContain("questions[0].options");
    expect(reasonText).toContain("duplicate");
  });

  test("cuts a long header and names a missing one Q2", () => {
    const long = "Which runner shall we use now?";
    expect(long).toHaveLength(30);
    const questions = accepted([
      { question: "Runner?", header: long, options: labels("bun", "vitest") },
      { question: "Package manager?", options: labels("bun", "npm") },
    ]);
    expect(questions[0]?.header).toBe(long.slice(0, CHOICE_HEADER_MAX_CHARS));
    expect(questions[0]?.header).toHaveLength(CHOICE_HEADER_MAX_CHARS);
    expect(questions[1]?.header).toBe("Q2");
  });

  test("names the failing path for a missing question text, options and multiSelect", () => {
    expect(reason([{ header: "Runner", options: labels("bun", "vitest") }])).toContain("questions[0].question");
    expect(reason([{ question: "Runner?", header: "Runner" }])).toContain("questions[0].options");
    const badMulti: unknown = {
      question: "Runner?",
      header: "Runner",
      options: labels("bun", "vitest"),
      multiSelect: "yes",
    };
    expect(reason([badMulti])).toContain("questions[0].multiSelect");
    const badLabel: unknown = { question: "Runner?", header: "Runner", options: [{ label: "" }, { label: "bun" }] };
    expect(reason([badLabel])).toContain("questions[0].options[0].label");
  });
});

describe("validateChoiceAnswers", () => {
  const single = question({
    question: "Which checks?",
    options: [option("lint"), option("typecheck"), option("tests")],
  });
  const multi = question({
    header: "Checks",
    question: "Which checks?",
    multiSelect: true,
    options: [option("lint"), option("tests")],
  });

  test("accepts one entry per question with ascending unique in-range indexes", () => {
    expect(validateChoiceAnswers([single, multi], [{ selected: [0] }, { selected: [0, 1] }])).toBeUndefined();
  });

  test("rejects a list that is not one entry per question", () => {
    expect(validateChoiceAnswers([single, multi], [{ selected: [0] }])).toBeString();
    expect(validateChoiceAnswers([single], [{ selected: [0] }, { selected: [1] }])).toBeString();
    const notAnArray: unknown = "lint";
    expect(validateChoiceAnswers([single], notAnArray)).toBeString();
  });

  test("rejects two selected indexes on a single-select question", () => {
    expect(validateChoiceAnswers([single], [{ selected: [0, 2] }])).toBeString();
  });

  test("rejects a single-select entry with both a selected index and an other", () => {
    expect(validateChoiceAnswers([single], [{ selected: [0], other: "e2e smoke" }])).toBeString();
  });

  test("rejects an out-of-range, non-integer, duplicate or unsorted index", () => {
    expect(validateChoiceAnswers([single], [{ selected: [3] }])).toBeString();
    const fractional: unknown = [{ selected: [0.5] }];
    expect(validateChoiceAnswers([single], fractional)).toBeString();
    expect(validateChoiceAnswers([multi], [{ selected: [1, 1] }])).toBeString();
    expect(validateChoiceAnswers([multi], [{ selected: [1, 0] }])).toBeString();
  });

  test("rejects an unanswered required question and a whitespace-only other", () => {
    expect(validateChoiceAnswers([single], [{ selected: [] }])).toBeString();
    expect(validateChoiceAnswers([single], [{ selected: [0], other: "   " }])).toBeString();
  });

  test("accepts an empty entry on a non-required question", () => {
    const optional = question({ required: false });
    expect(validateChoiceAnswers([optional], [{ selected: [] }])).toBeUndefined();
  });

  test("rejects an other on a question whose allowOther is false", () => {
    const closed = question({ allowOther: false, required: false });
    expect(validateChoiceAnswers([closed], [{ selected: [], other: "e2e smoke" }])).toBeString();
  });

  test("rejects an entry that is not an object", () => {
    const notAnEntry: unknown = ["lint"];
    expect(validateChoiceAnswers([single], notAnEntry)).toBeString();
  });
});

describe("formatChoiceAnswers", () => {
  test("writes the question, its labels and the other on one line", () => {
    const checks = question({
      question: "Which checks?",
      options: [option("lint"), option("typecheck"), option("tests")],
    });
    expect(formatChoiceAnswers([checks], [{ selected: [0, 2], other: "e2e smoke" }])).toBe(
      'Which checks? -> lint, tests, Other: "e2e smoke"',
    );
  });

  test("joins two questions with a newline, in question order, and writes (skipped)", () => {
    const first = question({ question: "Runner?", options: [option("bun"), option("vitest")] });
    const second = question({
      header: "Docs",
      question: "Docs?",
      required: false,
      options: [option("yes"), option("no")],
    });
    expect(formatChoiceAnswers([first, second], [{ selected: [1] }, { selected: [] }])).toBe(
      "Runner? -> vitest\nDocs? -> (skipped)",
    );
  });

  test("writes only the other when no label is selected", () => {
    const closed = question({ allowOther: true, required: false });
    expect(formatChoiceAnswers([closed], [{ selected: [], other: "deno" }])).toBe('Runner? -> Other: "deno"');
  });
});

describe("renderChoiceQuestionsText", () => {
  const first = question({
    header: "Runner",
    question: "Which runner?",
    options: [option("bun", "the runtime"), option("vitest")],
  });
  const second = question({ header: "Checks", question: "Which checks?", options: [option("lint"), option("tests")] });

  test("numbers the questions and their options and states the single-select instruction", () => {
    const text = renderChoiceQuestionsText("Pick:", [first, second]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Pick:");
    expect(lines[1]).toBe("(1/2) Which runner?");
    expect(lines[2]).toBe("1. bun - the runtime");
    expect(lines[3]).toBe("2. vitest");
    expect(lines).toContain("(2/2) Which checks?");
    expect(lines).toContain("1. lint");
    expect(lines).toContain("Reply with one number or label.");
    expect(lines).not.toContain("Reply with numbers or labels, separated by commas.");
  });

  test("leaves one question unnumbered and states the multi-select instruction for it", () => {
    const text = renderChoiceQuestionsText("", [question({ question: "Which checks?", multiSelect: true })]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Which checks?");
    expect(lines).not.toContain("(1/1) Which checks?");
    expect(lines).toContain("Reply with numbers or labels, separated by commas.");
  });
});

describe("@nathapp/nax-agent entry", () => {
  test("exports the choice-question contract with usable values", () => {
    expect(entry.CHOICE_MAX_QUESTIONS).toBe(4);
    expect(entry.CHOICE_HEADER_MAX_CHARS).toBe(16);
    const questions: readonly ChoiceQuestion[] = [
      {
        header: "Runner",
        question: "Runner?",
        options: [{ label: "bun" }, { label: "vitest" }],
        multiSelect: false,
        allowOther: true,
        required: true,
      },
    ];
    const answers: readonly ChoiceAnswer[] = [{ selected: [1] }];
    const result: ChoiceAskResult = { text: entry.formatChoiceAnswers(questions, answers), answers };
    expect(result).toEqual({ text: "Runner? -> vitest", answers: [{ selected: [1] }] });
    expect(entry.parseChoiceQuestions(questions, LIMITS).ok).toBe(true);
    expect(entry.validateChoiceAnswers(questions, answers)).toBeUndefined();
    expect(entry.renderChoiceQuestionsText("Pick", questions)).toContain("2. vitest");
  });
});
