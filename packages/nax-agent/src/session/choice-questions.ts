/**
 * US-001: the shared choice-question contract. One question set travels from a
 * model tool call, through the session's ask port, to whatever renders it
 * (chat card, ACP form, plain text). Everything here is pure: the parse, the
 * answer validation and the two renderings the consumers that ignore
 * `questions` still show.
 */

export interface ChoiceOption {
  readonly label: string;
  readonly description?: string;
}

export interface ChoiceQuestion {
  /** Short tab label; cut to CHOICE_HEADER_MAX_CHARS. */
  readonly header: string;
  readonly question: string;
  readonly options: readonly ChoiceOption[];
  readonly multiSelect: boolean;
  /** Whether a free-text "Other" answer is accepted. */
  readonly allowOther: boolean;
  /** Whether the person must answer it; a non-required question may be left empty. */
  readonly required: boolean;
}

export interface ChoiceAnswer {
  /** 0-based option indexes, ascending, unique. */
  readonly selected: readonly number[];
  readonly other?: string;
}

export interface ChoiceAskResult {
  /** What the person's answer reads as: formatChoiceAnswers(...) or the raw text of a plain reply. */
  readonly text: string;
  /** Absent when the embedder answered with a plain { text } reply. */
  readonly answers?: readonly ChoiceAnswer[];
}

export const CHOICE_MAX_QUESTIONS = 4;
export const CHOICE_HEADER_MAX_CHARS = 16;

/** The fewest options a question may offer: a choice needs a choice. */
const CHOICE_MIN_OPTIONS = 2;

const SINGLE_INSTRUCTION = "Reply with one number or label.";
const MULTI_INSTRUCTION = "Reply with numbers or labels, separated by commas.";

export interface ChoiceLimits {
  readonly maxOptions: number;
  readonly allowOther: boolean;
}

/** One accepted or rejected step of a parse; `reason` names the failing path. */
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** A whole question-set parse: accepted questions, or the first failing path. */
type ChoiceParseResult =
  | { readonly ok: true; readonly questions: readonly ChoiceQuestion[] }
  | { readonly ok: false; readonly reason: string };

function rejected<T>(reason: string): Parsed<T> {
  return { ok: false, reason };
}

function rejectedParse(reason: string): ChoiceParseResult {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A non-empty string, untrimmed: a label's own spacing is the caller's choice. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function parseText(value: unknown, at: string): Parsed<string> {
  const text = nonEmptyString(value);
  return text === undefined ? rejected(`${at}: expected a non-empty string`) : { ok: true, value: text };
}

function parseHeader(value: unknown, index: number, at: string): Parsed<string> {
  if (value === undefined) return { ok: true, value: `Q${index + 1}` };
  if (typeof value !== "string") return rejected(`${at}.header: expected a string`);
  const cut = value.trim().slice(0, CHOICE_HEADER_MAX_CHARS);
  return { ok: true, value: cut === "" ? `Q${index + 1}` : cut };
}

function parseMultiSelect(value: unknown, at: string): Parsed<boolean> {
  if (value === undefined) return { ok: true, value: false };
  return typeof value === "boolean" ? { ok: true, value } : rejected(`${at}.multiSelect: expected a boolean`);
}

function parseDescription(value: unknown, at: string): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === "string" ? { ok: true, value } : rejected(`${at}.description: expected a string`);
}

function parseOption(input: unknown, at: string): Parsed<ChoiceOption> {
  if (!isRecord(input)) return rejected(`${at}: expected an object`);
  const label = parseText(input.label, `${at}.label`);
  if (!label.ok) return label;
  const description = parseDescription(input.description, at);
  if (!description.ok) return description;
  return {
    ok: true,
    value:
      description.value === undefined ? { label: label.value } : { label: label.value, description: description.value },
  };
}

/** Case-insensitive: two labels that read the same must not both be offered. */
function findDuplicate(options: readonly ChoiceOption[], label: string): boolean {
  const lowered = label.toLowerCase();
  return options.some((option) => option.label.toLowerCase() === lowered);
}

function parseOptions(input: unknown, at: string, limits: ChoiceLimits): Parsed<readonly ChoiceOption[]> {
  const path = `${at}.options`;
  const expected = `expected ${CHOICE_MIN_OPTIONS}-${limits.maxOptions} options`;
  if (!Array.isArray(input)) return rejected(`${path}: ${expected}`);
  if (input.length < CHOICE_MIN_OPTIONS || input.length > limits.maxOptions) {
    return rejected(`${path}: ${expected}, got ${input.length}`);
  }
  const options: ChoiceOption[] = [];
  for (const [index, raw] of input.entries()) {
    const option = parseOption(raw, `${path}[${index}]`);
    if (!option.ok) return option;
    if (findDuplicate(options, option.value.label)) {
      return rejected(`${path}[${index}].label: duplicate label "${option.value.label}"`);
    }
    options.push(option.value);
  }
  return { ok: true, value: options };
}

function parseQuestion(input: unknown, index: number, limits: ChoiceLimits): Parsed<ChoiceQuestion> {
  const at = `questions[${index}]`;
  if (!isRecord(input)) return rejected(`${at}: expected an object`);
  const question = parseText(input.question, `${at}.question`);
  if (!question.ok) return question;
  const header = parseHeader(input.header, index, at);
  if (!header.ok) return header;
  const options = parseOptions(input.options, at, limits);
  if (!options.ok) return options;
  const multiSelect = parseMultiSelect(input.multiSelect, at);
  if (!multiSelect.ok) return multiSelect;
  return {
    ok: true,
    value: {
      header: header.value,
      question: question.value,
      options: options.value,
      multiSelect: multiSelect.value,
      allowOther: limits.allowOther,
      required: true,
    },
  };
}

/**
 * Reads a model-supplied question set into the contract. The reason names the
 * first failing path, so a model can correct the one field it got wrong.
 */
export function parseChoiceQuestions(input: unknown, limits: ChoiceLimits): ChoiceParseResult {
  if (!Array.isArray(input))
    return rejectedParse(`questions: expected an array of 1-${CHOICE_MAX_QUESTIONS} questions`);
  if (input.length < 1 || input.length > CHOICE_MAX_QUESTIONS) {
    return rejectedParse(`questions: expected 1-${CHOICE_MAX_QUESTIONS} questions, got ${input.length}`);
  }
  const questions: ChoiceQuestion[] = [];
  for (const [index, raw] of input.entries()) {
    const question = parseQuestion(raw, index, limits);
    if (!question.ok) return rejectedParse(question.reason);
    questions.push(question.value);
  }
  return { ok: true, questions };
}

function readSelected(question: ChoiceQuestion, input: unknown, at: string): Parsed<readonly number[]> {
  if (!Array.isArray(input)) return rejected(`${at}.selected: expected an array of indexes`);
  let previous = -1;
  for (const [index, value] of input.entries()) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return rejected(`${at}.selected[${index}]: expected an integer`);
    }
    if (value <= previous) return rejected(`${at}.selected: expected ascending unique indexes`);
    if (value < 0 || value >= question.options.length) {
      return rejected(`${at}.selected[${index}]: ${value} is out of range`);
    }
    previous = value;
  }
  if (!question.multiSelect && input.length > 1) {
    return rejected(`${at}.selected: a single-select question takes at most one index`);
  }
  return { ok: true, value: input };
}

function readOther(question: ChoiceQuestion, input: unknown, at: string): Parsed<string | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  if (typeof input !== "string") return rejected(`${at}.other: expected a string`);
  if (!question.allowOther) return rejected(`${at}.other: this question does not accept an other`);
  if (input.trim() === "") return rejected(`${at}.other: expected non-empty text`);
  return { ok: true, value: input };
}

function validateAnswer(question: ChoiceQuestion, input: unknown, index: number): string | undefined {
  const at = `answers[${index}]`;
  if (!isRecord(input)) return `${at}: expected an object`;
  const selected = readSelected(question, input.selected, at);
  if (!selected.ok) return selected.reason;
  const other = readOther(question, input.other, at);
  if (!other.ok) return other.reason;
  const answered = selected.value.length > 0 || other.value !== undefined;
  if (!question.multiSelect && selected.value.length > 0 && other.value !== undefined) {
    return `${at}: a single-select question takes a selected index or an other, not both`;
  }
  if (question.required && !answered) return `${at}: a required question needs a selected index or an other`;
  return undefined;
}

/** `undefined` for an answer list the questions accept; a reason otherwise. */
export function validateChoiceAnswers(questions: readonly ChoiceQuestion[], answers: unknown): string | undefined {
  if (!Array.isArray(answers)) return `answers: expected ${questions.length} answers`;
  if (answers.length !== questions.length) {
    return `answers: expected ${questions.length} answers, got ${answers.length}`;
  }
  for (const [index, question] of questions.entries()) {
    const reason = validateAnswer(question, answers[index], index);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

function selectedLabels(question: ChoiceQuestion, answer: ChoiceAnswer | undefined): string[] {
  const selected = answer?.selected ?? [];
  return selected
    .map((index) => question.options[index]?.label)
    .filter((label): label is string => label !== undefined);
}

/** `Which checks? -> lint, tests, Other: "e2e smoke"`; `(skipped)` when unanswered. */
function formatAnswer(question: ChoiceQuestion, answer: ChoiceAnswer | undefined): string {
  const parts = selectedLabels(question, answer);
  if (answer?.other !== undefined) parts.push(`Other: "${answer.other}"`);
  return parts.length === 0 ? "(skipped)" : parts.join(", ");
}

/** One line per question, in question order. */
export function formatChoiceAnswers(questions: readonly ChoiceQuestion[], answers: readonly ChoiceAnswer[]): string {
  return questions
    .map((question, index) => `${question.question} -> ${formatAnswer(question, answers[index])}`)
    .join("\n");
}

function questionLines(question: ChoiceQuestion, index: number, total: number): string[] {
  const prefix = total > 1 ? `(${index + 1}/${total}) ` : "";
  const lines = [`${prefix}${question.question}`];
  for (const [optionIndex, option] of question.options.entries()) {
    const description = option.description === undefined ? "" : ` - ${option.description}`;
    lines.push(`${optionIndex + 1}. ${option.label}${description}`);
  }
  lines.push(question.multiSelect ? MULTI_INSTRUCTION : SINGLE_INSTRUCTION);
  return lines;
}

/**
 * The plain-text rendering every consumer that ignores `questions` still shows
 * (koda, the nax-agent ACP server, Telegram): the prompt, then each question's
 * line, numbered options and the reply instruction.
 */
export function renderChoiceQuestionsText(prompt: string, questions: readonly ChoiceQuestion[]): string {
  const lines: string[] = prompt.trim() === "" ? [] : [prompt];
  for (const [index, question] of questions.entries()) {
    lines.push(...questionLines(question, index, questions.length));
  }
  return lines.join("\n");
}
