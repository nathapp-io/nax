/**
 * US-004: the pure choice-card state model. Every case drives the reducer directly — no Ink, no
 * React, no timers — and asserts both the state it returns and the outcome it reports.
 */
import { describe, expect, test } from "bun:test";
import type { ChoiceQuestion } from "@nathapp/nax-agent";
import {
  type ChoiceKey,
  type ChoiceReduction,
  type ChoiceState,
  initialChoiceState,
  reduceChoiceKey,
} from "@/tui/chat/choice-question";

const OPTIONS = [{ label: "one" }, { label: "two" }, { label: "three" }];

/** One question, with only the field a case is about overridden. */
function question(overrides: Partial<ChoiceQuestion> = {}): ChoiceQuestion {
  return {
    header: "Q1",
    question: "Which checks?",
    options: OPTIONS,
    multiSelect: false,
    allowOther: false,
    required: true,
    ...overrides,
  };
}

/** Two questions; `second` overrides the second one, where a tab change is observable. */
function pair(second: Partial<ChoiceQuestion> = {}): readonly ChoiceQuestion[] {
  return [question(), question({ header: "Q2", ...second })];
}

const UP: ChoiceKey = { kind: "up" };
const DOWN: ChoiceKey = { kind: "down" };
const LEFT: ChoiceKey = { kind: "left" };
const RIGHT: ChoiceKey = { kind: "right" };
const RETURN: ChoiceKey = { kind: "return" };
const ESCAPE: ChoiceKey = { kind: "escape" };
const SPACE: ChoiceKey = { kind: "space" };
const BACKSPACE: ChoiceKey = { kind: "backspace" };

function char(text: string): ChoiceKey {
  return { kind: "char", char: text };
}

/** The reduction after a run of keys, so a case can set up a state or drive several keys at once. */
function press(
  state: ChoiceState,
  questions: readonly ChoiceQuestion[],
  ...keys: readonly ChoiceKey[]
): ChoiceReduction {
  let result: ChoiceReduction = { state };
  for (const key of keys) result = reduceChoiceKey(result.state, questions, key);
  return result;
}

/** The state with the cursor on the `Other...` row of three options plus Other. */
function onOtherRow(questions: readonly ChoiceQuestion[], state: ChoiceState): ChoiceState {
  return press(state, questions, DOWN, DOWN, DOWN).state;
}

describe("initialChoiceState", () => {
  test("AC-1 starts on tab 0 with an empty selection per question and nothing open", () => {
    const questions = pair({ multiSelect: true });
    expect(initialChoiceState(questions)).toEqual({
      tab: 0,
      cursor: 0,
      selected: [[], []],
      other: [undefined, undefined],
      editing: false,
      draft: "",
      review: false,
    });
  });
});

describe("reduceChoiceKey on a single-select question", () => {
  test("AC-2 down then return selects index 1 and submits one answer", () => {
    const questions = [question()];
    const start = initialChoiceState(questions);
    const moved = reduceChoiceKey(start, questions, DOWN);
    expect(moved.state.cursor).toBe(1);
    expect(moved.outcome).toBeUndefined();
    const chosen = reduceChoiceKey(moved.state, questions, RETURN);
    expect(chosen.state.selected).toEqual([[1]]);
    expect(chosen.outcome).toEqual({ kind: "submit", answers: [{ selected: [1] }] });
  });

  test("AC-3 a digit selects its option and advances; a digit past the options is ignored", () => {
    const questions = pair();
    const start = initialChoiceState(questions);
    const picked = reduceChoiceKey(start, questions, char("3"));
    expect(picked.state.selected).toEqual([[2], []]);
    expect(picked.state.tab).toBe(1);
    expect(picked.outcome).toBeUndefined();
    expect(reduceChoiceKey(start, questions, char("4")).state).toEqual(start);
  });

  test("AC-4 the cursor clamps at row 0 and at the Other... row", () => {
    const questions = [question({ allowOther: true })];
    const start = initialChoiceState(questions);
    expect(reduceChoiceKey(start, questions, UP).state.cursor).toBe(0);
    expect(press(start, questions, DOWN, DOWN, DOWN).state.cursor).toBe(3);
    expect(press(start, questions, DOWN, DOWN, DOWN, DOWN).state.cursor).toBe(3);
  });

  test("AC-9 selecting an option clears that question's other", () => {
    const questions = [question({ allowOther: true }), question({ header: "Q2" })];
    const start = press(
      initialChoiceState(questions),
      questions,
      DOWN,
      DOWN,
      DOWN,
      RETURN,
      char("d"),
      char("e"),
      char("n"),
      char("o"),
      RETURN,
    );
    expect(start.state.other).toEqual(["deno", undefined]);
    const back = press(start.state, questions, LEFT, SPACE);
    expect(back.state.selected).toEqual([[0], []]);
    expect(back.state.other).toEqual([undefined, undefined]);
  });
});

describe("reduceChoiceKey on a multi-select question", () => {
  test("AC-5 space and a digit toggle the selection without an outcome", () => {
    const questions = [question({ multiSelect: true })];
    const start = initialChoiceState(questions);
    const first = reduceChoiceKey(start, questions, SPACE);
    expect(first.state.selected).toEqual([[0]]);
    expect(first.outcome).toBeUndefined();
    const second = reduceChoiceKey(first.state, questions, char("3"));
    expect(second.state.selected).toEqual([[0, 2]]);
    const third = reduceChoiceKey(second.state, questions, SPACE);
    expect(third.state.selected).toEqual([[2]]);
    expect(third.outcome).toBeUndefined();
  });

  test("AC-17 space on the Other... row edits and leaves the selection alone", () => {
    const questions = [question({ multiSelect: true, allowOther: true })];
    const selected = press(initialChoiceState(questions), questions, SPACE);
    expect(selected.state.selected).toEqual([[0]]);
    const editing = reduceChoiceKey(onOtherRow(questions, selected.state), questions, SPACE);
    expect(editing.state.editing).toBe(true);
    expect(editing.state.selected).toEqual([[0]]);
  });
});

describe("reduceChoiceKey advancing", () => {
  test("AC-6 return on an unanswered required question stays on its tab", () => {
    const questions = [question({ multiSelect: true }), question({ header: "Q2" })];
    const start = initialChoiceState(questions);
    const stayed = reduceChoiceKey(start, questions, RETURN);
    expect(stayed.state.tab).toBe(0);
    expect(stayed.state).toEqual(start);
    expect(stayed.state.review).toBe(false);
    expect(stayed.outcome).toBeUndefined();
  });

  test("AC-7 return on an unanswered non-required question submits an empty answer", () => {
    const questions = [question({ multiSelect: true, required: false })];
    const submitted = reduceChoiceKey(initialChoiceState(questions), questions, RETURN);
    expect(submitted.outcome).toEqual({ kind: "submit", answers: [{ selected: [] }] });
  });

  test("AC-13 answering the last question opens the review step without an outcome", () => {
    const questions = pair();
    const reviewing = press(initialChoiceState(questions), questions, RIGHT, RETURN);
    expect(reviewing.state.tab).toBe(1);
    expect(reviewing.state.review).toBe(true);
    // The review opens at its top, not where the last question's pointer happened to be.
    expect(reviewing.state.cursor).toBe(0);
    expect(reviewing.outcome).toBeUndefined();
  });

  test("AC-19 with one question the advancing key submits and review never opens", () => {
    const questions = [question()];
    const start = initialChoiceState(questions);
    const moved = press(start, questions, RIGHT, LEFT, DOWN);
    expect(moved.state.tab).toBe(0);
    expect(moved.state.review).toBe(false);
    const submitted = reduceChoiceKey(press(start, questions, SPACE).state, questions, RETURN);
    expect(submitted.state.review).toBe(false);
    expect(submitted.outcome).toEqual({ kind: "submit", answers: [{ selected: [0] }] });
  });
});

describe("reduceChoiceKey editing an other", () => {
  test("AC-8 return on the Other... row starts editing", () => {
    const questions = [question({ allowOther: true }), question({ header: "Q2" })];
    const at = onOtherRow(questions, initialChoiceState(questions));
    expect(at.cursor).toBe(3);
    const editing = reduceChoiceKey(at, questions, RETURN);
    expect(editing.state.editing).toBe(true);
    expect(editing.state.draft).toBe("");
    expect(editing.outcome).toBeUndefined();
  });

  test("AC-8 typed characters, spaces included, build the draft and backspace removes one", () => {
    const questions = [question({ allowOther: true }), question({ header: "Q2" })];
    const at = onOtherRow(questions, initialChoiceState(questions));
    const editing = reduceChoiceKey(at, questions, RETURN);
    const typed = press(editing.state, questions, char("d"), char("1"), SPACE);
    expect(typed.state.draft).toBe("d1 ");
    expect(press(typed.state, questions, BACKSPACE).state.draft).toBe("d1");
  });

  test("AC-8 return with a draft stores it as other and advances", () => {
    const questions = [question({ allowOther: true }), question({ header: "Q2" })];
    const at = onOtherRow(questions, initialChoiceState(questions));
    const typed = press(at, questions, RETURN, char("d"), char("e"), char("n"), char("o"));
    expect(typed.state.draft).toBe("deno");
    const committed = reduceChoiceKey(typed.state, questions, RETURN);
    expect(committed.state.other).toEqual(["deno", undefined]);
    expect(committed.state.editing).toBe(false);
    expect(committed.state.draft).toBe("");
    expect(committed.state.tab).toBe(1);
    expect(committed.outcome).toBeUndefined();
  });

  test("AC-8 committing an other on a single-select question clears its selected index", () => {
    const questions = [question({ allowOther: true }), question({ header: "Q2" })];
    const chosen = press(initialChoiceState(questions), questions, SPACE);
    expect(chosen.state.selected).toEqual([[0], []]);
    const at = onOtherRow(questions, chosen.state);
    const committed = press(at, questions, RETURN, char("d"), char("e"), char("n"), char("o"), RETURN);
    expect(committed.state.selected).toEqual([[], []]);
    expect(committed.state.other).toEqual(["deno", undefined]);
    expect(committed.state.tab).toBe(1);
  });

  test("AC-10 a whitespace-only draft keeps editing", () => {
    const questions = [question({ allowOther: true, required: false }), question({ header: "Q2" })];
    const at = onOtherRow(questions, initialChoiceState(questions));
    const still = press(at, questions, RETURN, SPACE, RETURN);
    expect(still.state.editing).toBe(true);
    expect(still.state.draft).toBe(" ");
    expect(still.outcome).toBeUndefined();
  });

  test("AC-10 escape leaves editing with other unchanged and does not decline", () => {
    const questions = [question({ allowOther: true }), question({ header: "Q2" })];
    const committed = press(
      initialChoiceState(questions),
      questions,
      DOWN,
      DOWN,
      DOWN,
      RETURN,
      char("d"),
      char("e"),
      char("n"),
      char("o"),
      RETURN,
    );
    expect(committed.state.other).toEqual(["deno", undefined]);
    const at = onOtherRow(questions, press(committed.state, questions, LEFT).state);
    const reopened = reduceChoiceKey(at, questions, RETURN);
    expect(reopened.state.editing).toBe(true);
    expect(reopened.state.draft).toBe("deno");
    const left = reduceChoiceKey(press(reopened.state, questions, char("x")).state, questions, ESCAPE);
    expect(left.state.editing).toBe(false);
    expect(left.state.other).toEqual(["deno", undefined]);
    expect(left.outcome).toBeUndefined();
  });
});

describe("reduceChoiceKey declining", () => {
  test("AC-11 escape outside editing declines the ask", () => {
    const questions = pair();
    const declined = reduceChoiceKey(initialChoiceState(questions), questions, ESCAPE);
    expect(declined.outcome).toEqual({ kind: "decline" });
  });
});

describe("reduceChoiceKey tabs", () => {
  test("AC-12 right and left move between tabs and right on the last tab stays", () => {
    const questions = pair();
    const start = initialChoiceState(questions);
    const second = reduceChoiceKey(start, questions, RIGHT);
    expect(second.state.tab).toBe(1);
    expect(second.state.review).toBe(false);
    const moved = press(second.state, questions, DOWN);
    expect(moved.state.cursor).toBe(1);
    const stayed = reduceChoiceKey(moved.state, questions, RIGHT);
    expect(stayed.state.tab).toBe(1);
    expect(stayed.state.cursor).toBe(1);
    expect(reduceChoiceKey(second.state, questions, LEFT).state.tab).toBe(0);
  });

  test("changing tab puts the cursor on the first selected option, else on row 0", () => {
    const questions = pair({ multiSelect: true });
    const chosen = press(initialChoiceState(questions), questions, RIGHT, DOWN, DOWN, SPACE);
    expect(chosen.state.tab).toBe(1);
    expect(chosen.state.selected).toEqual([[], [2]]);
    const back = reduceChoiceKey(chosen.state, questions, LEFT);
    expect(back.state.tab).toBe(0);
    expect(back.state.cursor).toBe(0);
    expect(reduceChoiceKey(back.state, questions, RIGHT).state.cursor).toBe(2);
  });
});

describe("reduceChoiceKey in the review step", () => {
  /** Two answered required questions, with the review step open. */
  function reviewing(): { questions: readonly ChoiceQuestion[]; state: ChoiceState } {
    const questions = pair();
    const start = initialChoiceState(questions);
    const state = press(start, questions, SPACE, RIGHT, DOWN, SPACE, RETURN).state;
    expect(state.review).toBe(true);
    return { questions, state };
  }

  test("AC-14 return submits one answer per question in question order", () => {
    const { questions, state } = reviewing();
    const submitted = reduceChoiceKey(state, questions, RETURN);
    expect(submitted.outcome).toEqual({
      kind: "submit",
      answers: [{ selected: [0] }, { selected: [1] }],
    });
  });

  test("AC-15 return with a required question unanswered reopens its tab", () => {
    const questions = pair({ required: false });
    const state = press(initialChoiceState(questions), questions, RIGHT, RETURN).state;
    expect(state.review).toBe(true);
    const reopened = reduceChoiceKey(state, questions, RETURN);
    expect(reopened.state.review).toBe(false);
    expect(reopened.state.tab).toBe(0);
    expect(reopened.state.cursor).toBe(0);
    expect(reopened.outcome).toBeUndefined();
  });

  test("AC-16 left leaves review on the last question", () => {
    const { questions, state } = reviewing();
    const back = reduceChoiceKey(state, questions, LEFT);
    expect(back.state.review).toBe(false);
    expect(back.state.tab).toBe(1);
    expect(back.outcome).toBeUndefined();
  });

  test("AC-16 up and down scroll the review, clamped at the first and last question", () => {
    const questions = [question(), question({ header: "Q2" }), question({ header: "Q3" })];
    const state = press(initialChoiceState(questions), questions, SPACE, RIGHT, SPACE, RIGHT, RETURN).state;
    expect(state.review).toBe(true);
    expect(state.cursor).toBe(0);
    expect(reduceChoiceKey(state, questions, UP).state.cursor).toBe(0);
    const down = reduceChoiceKey(state, questions, DOWN);
    expect(down.state.cursor).toBe(1);
    expect(down.state.review).toBe(true);
    expect(down.outcome).toBeUndefined();
    const bottom = press(down.state, questions, DOWN, DOWN);
    expect(bottom.state.cursor).toBe(2);
    expect(reduceChoiceKey(bottom.state, questions, UP).state.cursor).toBe(1);
  });

  test("AC-16 return submits and left leaves from any review position", () => {
    const { questions, state } = reviewing();
    const scrolled = reduceChoiceKey(state, questions, DOWN).state;
    expect(scrolled.cursor).toBe(1);
    const submitted = reduceChoiceKey(scrolled, questions, RETURN);
    expect(submitted.outcome).toEqual({ kind: "submit", answers: [{ selected: [0] }, { selected: [1] }] });
    const back = reduceChoiceKey(scrolled, questions, LEFT);
    expect(back.state.review).toBe(false);
    expect(back.state.tab).toBe(1);
  });

  test("AC-16 return reopens the first unanswered required question from any review position", () => {
    // Question 0 stays required and unanswered; question 1 is optional, so the review opens.
    const questions = pair({ required: false });
    const state = press(initialChoiceState(questions), questions, RIGHT, RETURN).state;
    expect(state.review).toBe(true);
    const scrolled = reduceChoiceKey(state, questions, DOWN).state;
    expect(scrolled.cursor).toBe(1);
    const reopened = reduceChoiceKey(scrolled, questions, RETURN);
    expect(reopened.state.review).toBe(false);
    expect(reopened.state.tab).toBe(0);
  });
});

describe("reduceChoiceKey immutability", () => {
  test("AC-18 every key returns a new state and leaves the input untouched", () => {
    const questions = [question({ allowOther: true }), question({ header: "Q2" })];
    const start = initialChoiceState(questions);
    const editing = press(start, questions, DOWN, DOWN, DOWN, RETURN, char("d")).state;
    const reviewing = press(start, questions, RIGHT, RETURN).state;
    expect(editing.editing).toBe(true);
    expect(reviewing.review).toBe(true);
    const keys: readonly ChoiceKey[] = [
      UP,
      DOWN,
      LEFT,
      RIGHT,
      RETURN,
      ESCAPE,
      SPACE,
      BACKSPACE,
      char("1"),
      char("9"),
      char("x"),
    ];
    for (const state of [start, editing, reviewing]) {
      const before = structuredClone(state);
      for (const key of keys) {
        expect(reduceChoiceKey(state, questions, key).state).not.toBe(state);
        expect(state).toEqual(before);
      }
    }
  });

  test("an ignored key keeps every value the same", () => {
    const questions = [question()];
    const start = initialChoiceState(questions);
    expect(reduceChoiceKey(start, questions, BACKSPACE).state).toEqual(start);
    expect(reduceChoiceKey(start, questions, char("x")).state).toEqual(start);
  });
});
