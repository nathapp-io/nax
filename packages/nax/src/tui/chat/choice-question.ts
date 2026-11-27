/**
 * US-004: the pure state model behind the choice card — the keys it answers to, the state it
 * keeps, and what each key does to that state.
 *
 * The card itself is drawn in US-005; nothing here builds a row, reads Ink, or touches a
 * session. Every call returns a new state, so a card can hold the state in a React value and
 * reduce a batch of keys in one tick without losing the earlier ones, and an ignored key still
 * hands back a fresh object: one rule for every key, no exceptions to reason about.
 *
 * The reducer is a small dispatch over the state rather than one branch tree: editing, the
 * review step and a question's own keys each have their own helper, because the three answer
 * different questions about the same key (while editing, a digit is a character; in review,
 * left is not a tab).
 */
import type { ChoiceAnswer, ChoiceQuestion } from "@nathapp/nax-agent";

/** A typed character that names an option: the digits 1 to 9, never 0. */
const DIGIT = /^[1-9]$/;

/** One key the card understands, after Ink's `(input, key)` has been normalised. */
export type ChoiceKey =
  | { readonly kind: "up" | "down" | "left" | "right" | "return" | "escape" | "space" | "backspace" }
  | { readonly kind: "char"; readonly char: string };

/** What the card knows while the person works through the questions. */
export interface ChoiceState {
  /** The question whose tab is shown, 0-based. */
  readonly tab: number;
  /**
   * The row the pointer is on: an option's index, or the `Other...` row's. In the review step it
   * is the question whose answer the review window shows.
   */
  readonly cursor: number;
  /** Per question, the selected option indexes, ascending and unique; never the `Other...` row. */
  readonly selected: readonly (readonly number[])[];
  /** Per question, the free-text answer when one was committed. */
  readonly other: readonly (string | undefined)[];
  /** Whether the inline `Other...` text box is open. */
  readonly editing: boolean;
  /** What the text box holds while editing; empty once it is closed. */
  readonly draft: string;
  /** Whether the review step replaces the question tabs. */
  readonly review: boolean;
}

/** What a key resolved: the ask is answered, or the person declined it. */
export type ChoiceOutcome =
  | { readonly kind: "submit"; readonly answers: readonly ChoiceAnswer[] }
  | { readonly kind: "decline" };

/** What a key left behind: always a state, and an outcome only when the ask is over. */
export interface ChoiceReduction {
  readonly state: ChoiceState;
  readonly outcome?: ChoiceOutcome;
}

/** A fresh state: the first question, nothing chosen, nothing open. */
export function initialChoiceState(questions: readonly ChoiceQuestion[]): ChoiceState {
  return {
    tab: 0,
    cursor: 0,
    selected: questions.map(() => []),
    other: questions.map(() => undefined),
    editing: false,
    draft: "",
    review: false,
  };
}

/** A key that changes nothing still returns a new state. */
function unchanged(state: ChoiceState): ChoiceReduction {
  return { state: { ...state } };
}

/** How many rows a question draws: its options, plus the `Other...` row when it takes one. */
function rowCount(question: ChoiceQuestion): number {
  return question.options.length + (question.allowOther ? 1 : 0);
}

/** Whether the cursor sits on the `Other...` row rather than on an option. */
function isOtherRow(question: ChoiceQuestion, cursor: number): boolean {
  return question.allowOther && cursor === question.options.length;
}

/** Where the cursor goes on a tab: its first selected option, else the first row. */
function firstSelectedRow(selected: readonly number[]): number {
  return selected[0] ?? 0;
}

/** The state on another tab, with the pointer where that tab's own selection says. */
function onTab(state: ChoiceState, tab: number): ChoiceState {
  return {
    ...state,
    tab,
    cursor: firstSelectedRow(state.selected[tab]),
    editing: false,
    draft: "",
    review: false,
  };
}

/** Up and down move the pointer, clamped at the first and last row. */
function moveCursor(state: ChoiceState, questions: readonly ChoiceQuestion[], delta: number): ChoiceState {
  const last = Math.max(rowCount(questions[state.tab]) - 1, 0);
  return { ...state, cursor: Math.min(Math.max(state.cursor + delta, 0), last) };
}

/** Left and right change tab, which only a multi-question ask has. */
function changeTab(state: ChoiceState, questions: readonly ChoiceQuestion[], delta: number): ChoiceState {
  if (questions.length < 2) return { ...state };
  const tab = Math.min(Math.max(state.tab + delta, 0), questions.length - 1);
  return tab === state.tab ? { ...state } : onTab(state, tab);
}

/** One key on a question: the pointer, the tab, the selection and the `Other...` row. */
function reduceQuestionKey(state: ChoiceState, questions: readonly ChoiceQuestion[], key: ChoiceKey): ChoiceReduction {
  const question = questions[state.tab];
  if ((key.kind === "space" || key.kind === "return") && isOtherRow(question, state.cursor)) {
    return { state: startEditing(state) };
  }
  if (key.kind === "up" || key.kind === "down") {
    return { state: moveCursor(state, questions, key.kind === "up" ? -1 : 1) };
  }
  if (key.kind === "left" || key.kind === "right") {
    return { state: changeTab(state, questions, key.kind === "left" ? -1 : 1) };
  }
  if (key.kind === "space") return { state: spaceSelection(state, questions) };
  if (key.kind === "return") return returnKey(state, questions);
  if (key.kind === "char") return charKey(state, questions, key.char);
  return unchanged(state);
}

/** The inline text box, seeded with the other the question already carries. */
function startEditing(state: ChoiceState): ChoiceState {
  return { ...state, editing: true, draft: state.other[state.tab] ?? "" };
}

/** The draft without its last character: one code point, so a pair is not split in half. */
function dropLast(draft: string): string {
  return [...draft].slice(0, -1).join("");
}

/**
 * Return while editing: a draft with something in it becomes the question's other — clearing a
 * single-select question's chosen option — and the card moves on. A blank draft leaves the box
 * open, because an empty other is not an answer.
 */
function commitOther(state: ChoiceState, questions: readonly ChoiceQuestion[]): ChoiceReduction {
  const text = state.draft.trim();
  if (text === "") return unchanged(state);
  const question = questions[state.tab];
  const selected = question.multiSelect ? state.selected : replaceAt(state.selected, state.tab, []);
  return advance(
    { ...state, editing: false, draft: "", selected, other: replaceAt(state.other, state.tab, text) },
    questions,
  );
}

/** One key while the text box is open: typing, deleting, escape and return mean only this. */
function reduceEditingKey(state: ChoiceState, questions: readonly ChoiceQuestion[], key: ChoiceKey): ChoiceReduction {
  if (key.kind === "return") return commitOther(state, questions);
  if (key.kind === "escape") return { state: { ...state, editing: false, draft: "" } };
  if (key.kind === "backspace") return { state: { ...state, draft: dropLast(state.draft) } };
  if (key.kind === "space") return { state: { ...state, draft: `${state.draft} ` } };
  if (key.kind === "char") return { state: { ...state, draft: `${state.draft}${key.char}` } };
  return unchanged(state);
}

/** `values` with one entry replaced: the one rule every immutable update in this module uses. */
function replaceAt<T>(values: readonly T[], index: number, value: T): readonly T[] {
  return values.map((current, at) => (at === index ? value : current));
}

/** One option chosen for the current question; a single-select question's other is cleared. */
function chooseOption(state: ChoiceState, index: number): ChoiceState {
  return {
    ...state,
    selected: replaceAt(state.selected, state.tab, [index]),
    other: replaceAt(state.other, state.tab, undefined),
  };
}

/** One option toggled on the current question, kept ascending and unique. */
function toggleOption(state: ChoiceState, index: number): ChoiceState {
  const rows = state.selected[state.tab];
  const next = rows.includes(index) ? rows.filter((row) => row !== index) : [...rows, index].sort((a, b) => a - b);
  return { ...state, selected: replaceAt(state.selected, state.tab, next) };
}

/** Whether a question has an answer: an option, or committed free text. */
function isAnswered(state: ChoiceState, tab: number): boolean {
  return state.selected[tab].length > 0 || state.other[tab] !== undefined;
}

/** The answer a question's current state reads as. */
function answerOf(state: ChoiceState, tab: number): ChoiceAnswer {
  const selected = state.selected[tab];
  const other = state.other[tab];
  return other === undefined ? { selected } : { selected, other };
}

/** One answer per question, in question order — what a submit carries. */
function answersOf(state: ChoiceState, questions: readonly ChoiceQuestion[]): readonly ChoiceAnswer[] {
  return questions.map((_question, tab) => answerOf(state, tab));
}

/**
 * The next step after an answer: the question after this one, the review step from the last
 * one, or — with a single question — the ask itself submitted. A required question with no
 * option chosen and no other committed holds the person on it.
 */
function advance(state: ChoiceState, questions: readonly ChoiceQuestion[]): ChoiceReduction {
  if (questions[state.tab].required && !isAnswered(state, state.tab)) return unchanged(state);
  if (questions.length === 1) {
    return { state: { ...state }, outcome: { kind: "submit", answers: answersOf(state, questions) } };
  }
  if (state.tab < questions.length - 1) return { state: onTab(state, state.tab + 1) };
  return { state: { ...state, review: true, cursor: 0 } };
}

/** Space chooses the pointer's option, or toggles it on a multi-select question. */
function spaceSelection(state: ChoiceState, questions: readonly ChoiceQuestion[]): ChoiceState {
  const question = questions[state.tab];
  return question.multiSelect ? toggleOption(state, state.cursor) : chooseOption(state, state.cursor);
}

/** Return chooses on a single-select question and then moves on; on a multi-select it only moves on. */
function returnKey(state: ChoiceState, questions: readonly ChoiceQuestion[]): ChoiceReduction {
  const question = questions[state.tab];
  return advance(question.multiSelect ? state : chooseOption(state, state.cursor), questions);
}

/** A key typing an option's number chooses it and moves on, when the ask has that many options. */
function charKey(state: ChoiceState, questions: readonly ChoiceQuestion[], text: string): ChoiceReduction {
  const question = questions[state.tab];
  const index = DIGIT.test(text) ? Number(text) - 1 : -1;
  if (index < 0 || index >= question.options.length) return unchanged(state);
  if (question.multiSelect) return { state: toggleOption(state, index) };
  return advance(chooseOption(state, index), questions);
}

/** The first required question nobody answered, or -1 when every one of them is. */
function firstUnansweredRequired(state: ChoiceState, questions: readonly ChoiceQuestion[]): number {
  return questions.findIndex((question, tab) => question.required && !isAnswered(state, tab));
}

/** Return in the review step: submit, or reopen the first required question still unanswered. */
function reviewReturn(state: ChoiceState, questions: readonly ChoiceQuestion[]): ChoiceReduction {
  const tab = firstUnansweredRequired(state, questions);
  if (tab >= 0) return { state: onTab(state, tab) };
  return { state: { ...state }, outcome: { kind: "submit", answers: answersOf(state, questions) } };
}

/**
 * The review step's window position: up and down walk the questions it lists, clamped at the
 * first and the last. The review lists every question, so a window too short for all of them
 * must still be able to reach each answer before the card is submitted.
 */
function moveReviewCursor(state: ChoiceState, questions: readonly ChoiceQuestion[], delta: number): ChoiceState {
  const last = Math.max(questions.length - 1, 0);
  return { ...state, cursor: Math.min(Math.max(state.cursor + delta, 0), last) };
}

/** One key in the review step: return submits or reopens, left returns, up and down scroll. */
function reduceReviewKey(state: ChoiceState, questions: readonly ChoiceQuestion[], key: ChoiceKey): ChoiceReduction {
  if (key.kind === "return") return reviewReturn(state, questions);
  if (key.kind === "left") return { state: onTab(state, questions.length - 1) };
  if (key.kind === "up" || key.kind === "down") {
    return { state: moveReviewCursor(state, questions, key.kind === "up" ? -1 : 1) };
  }
  return unchanged(state);
}

/**
 * One key against the state it was pressed in. `questions` is the ask's question set, which
 * never changes while the card is open.
 */
export function reduceChoiceKey(
  state: ChoiceState,
  questions: readonly ChoiceQuestion[],
  key: ChoiceKey,
): ChoiceReduction {
  if (state.editing) return reduceEditingKey(state, questions, key);
  if (key.kind === "escape") return { state: { ...state }, outcome: { kind: "decline" } };
  if (state.review) return reduceReviewKey(state, questions, key);
  return reduceQuestionKey(state, questions, key);
}
