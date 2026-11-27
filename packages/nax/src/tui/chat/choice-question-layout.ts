/**
 * The choice card's rows — where every row a structured question draws is decided.
 *
 * The card is framed like every other ask: the theme's rule across the top, the title, then
 * the question set. A set of two or more questions gets a tab strip; the tab being shown gets
 * its prompt, its question and its options; and the card closes on the keys it answers to, the
 * countdown and the bottom rule. `choiceQuestionLayout` never draws more rows than the budget
 * it is given, so the screen can reserve exactly what the card will draw.
 *
 * The rows are decided here and nowhere else. The measurement is built from the same drawing
 * code, which is what keeps a state-free measurement honest — `measureFrameSurfaces` has no
 * card state — by reporting the largest draw the card can produce over every tab and the
 * review step.
 *
 * Long option lists are windowed rather than truncated: the rows that fit keep the cursor
 * visible and `(n more above)` / `(n more below)` name what the window refused, and those
 * markers count against the budget like any other row. The question line, the hint row and the
 * countdown are never withheld; the prompt and the question are cut to one row each before a
 * single option row is given up.
 */
import { type ChoiceAnswer, type ChoiceQuestion, formatChoiceAnswers } from "@nathapp/nax-agent";
import type { AskBorder, AskCardChoiceQuestion } from "./ask-card";
import { type ChoiceState, initialChoiceState } from "./choice-question";
import { _askCardDeps, countdownRows } from "./countdown";
import { type LayoutContext, oneLine, resolveWidth, SPACE, type SpanStyle, styled, textLines } from "./layout-lines";
import { displayWidth, type Span, type StyledLine } from "./styled-line";
import type { ChatTheme } from "./theme";
import { elideSpansEnd, wrapSpans } from "./wrap";

/** The single-select option's chosen and unchosen marks. */
const SINGLE_ON = "(*) ";
const SINGLE_OFF = "( ) ";
/** The multi-select option's chosen and unchosen marks. */
const MULTI_ON = "[x] ";
const MULTI_OFF = "[ ] ";
/** The row that takes a free-text answer. */
const OTHER_LABEL = "Other...";
/** What the window's two markers say, after the number of rows they stand for. */
const MORE_ABOVE = "more above";
const MORE_BELOW = "more below";
/** What separates the parts of a hint row. */
const HINT_SEPARATOR = " · ";
/** The hint's own words, one phrase per key. */
const HINT_SINGLE = "enter chooses";
const HINT_MULTI = "space toggles · enter continues";
const HINT_OTHER = "down for Other";
const HINT_TABS = "left/right for tabs";
const HINT_EDITING = "type · enter keeps · esc cancels";
const HINT_REVIEW = "enter submits · left goes back";
const HINT_DECLINE = "esc declines";
/** The columns between an option's label and the description drawn after it. */
const DESCRIPTION_GAP = "  ";
/** The frame's rules, and the one-row floor of each body part the minimum counts. */
const FRAME_RULE_ROWS = 1;
const ONE_QUESTION_ROW = 1;
const ONE_OPTION_ROW = 1;
/** A `(n more ...)` row is cut to the width, so a marker is always exactly one row. */
const ONE_MARKER_ROW = 1;
/** "Unlimited": a budget no card can reach, so a measurement sees the whole drawing. */
export const CHOICE_UNLIMITED_BUDGET = Number.POSITIVE_INFINITY;

/** Everything the card draws but the budget it is fitted into. */
export interface ChoiceQuestionContentOptions {
  /** The columns the card is drawn into. */
  readonly width: number;
  readonly theme: ChatTheme;
  /** The ask's expiry, as the session reported it — the countdown row's text. */
  readonly expiresAt: string;
  /** The clock the countdown is read at; absent means `_askCardDeps.now()`. */
  readonly nowMs?: number;
}

export interface ChoiceQuestionLayoutOptions extends ChoiceQuestionContentOptions {
  /** The rows the screen can give the whole card. */
  readonly budget: number;
}

/** The rows the choice card draws, already fitted to the rows the screen can spare. */
export interface ChoiceQuestionLayout {
  /** The frame's top rule, the title, the tab strip, the prompt and the question line. */
  readonly head: readonly StyledLine[];
  /**
   * The rows between the question and the card's tail: the option window and its `Other...`
   * row, or — on the review step — the questions it lists. These are the rows a short card
   * withholds first.
   */
  readonly middle: readonly StyledLine[];
  /** The hint row, the countdown and the frame's bottom rule — never withheld. */
  readonly tail: readonly StyledLine[];
  /** How many list rows the window withheld — the count its `(n more ...)` rows stand for. */
  readonly elided: number;
  /** Every row the card occupies, `head` + `middle` + `tail`. */
  readonly rows: number;
}

/** What the choice card measures: the rows it cannot be drawn in fewer of, and the rows it wants. */
export interface ChoiceQuestionMeasurement {
  readonly minimum: number;
  readonly desired: number;
}

/** A whole number of rows; an unlimited budget stays unlimited. */
function rowBudget(budget: number): number {
  if (!Number.isFinite(budget)) return CHOICE_UNLIMITED_BUDGET;
  return Math.max(1, Math.floor(budget));
}

/** The card's drawing context: the resolved width, the theme, and no expanded detail. */
function contextFor(options: ChoiceQuestionContentOptions): LayoutContext {
  return { width: resolveWidth(options.width), theme: options.theme, expanded: false };
}

/** The frame's rule: the theme's rule glyph across the card, in the ask's border tone. */
function frameRule(context: LayoutContext, border: AskBorder): StyledLine {
  return [styled(context.theme.glyphs.rule.repeat(context.width), { color: border })];
}

/** The theme's ellipsis, in the muted tone: what a row cut to the width ends in. */
function ellipsis(context: LayoutContext): Span {
  return styled(context.theme.glyphs.ellipsis, { color: "muted" });
}

/**
 * One text's wrapped rows. Each source line is wrapped on its own, so a question holding a
 * line break draws the rows it was measured as rather than handing ink a raw newline.
 */
function textRows(text: string, style: SpanStyle, context: LayoutContext): StyledLine[] {
  return textLines(text).flatMap((physical) => wrapSpans([styled(physical, style)], { width: context.width }));
}

/** The same text flattened to one row, cut to the width and marked when it had to be. */
function elidedRow(text: string, style: SpanStyle, context: LayoutContext): StyledLine {
  return elideSpansEnd([styled(oneLine(text), style)], context.width, ellipsis(context));
}

/** One row cut to the card's width, whatever its text. */
function cutRow(spans: readonly Span[], context: LayoutContext): StyledLine {
  return elideSpansEnd(spans, context.width, ellipsis(context));
}

/** The question whose tab is shown. */
function currentQuestion(model: AskCardChoiceQuestion, state: ChoiceState): ChoiceQuestion | undefined {
  return model.questions[state.tab] ?? model.questions[0];
}

/** The answer a question's state reads as — what `formatChoiceAnswers` reports back. */
function answerOf(state: ChoiceState, tab: number): ChoiceAnswer {
  const selected = state.selected[tab] ?? [];
  const other = state.other[tab];
  return other === undefined ? { selected } : { selected, other };
}

/** The pointer on the cursor's row, and the blank columns that keep the boxes in column. */
function pointer(context: LayoutContext, cursor: boolean): Span {
  const glyph = context.theme.glyphs.pointer;
  if (!cursor) return styled(SPACE.repeat(displayWidth(glyph) + SPACE.length));
  return styled(`${glyph}${SPACE}`, { color: "accent" });
}

/** The tab strip `[Header] [Header] [Submit]`: the active tab bold, an answered one in success. */
function tabStripRows(model: AskCardChoiceQuestion, state: ChoiceState, context: LayoutContext): StyledLine[] {
  if (model.questions.length < 2 || state.review) return [];
  const spans: Span[] = [];
  for (const [index, question] of model.questions.entries()) {
    if (index > 0) spans.push(styled(SPACE));
    const answered = (state.selected[index]?.length ?? 0) > 0 || state.other[index] !== undefined;
    const style: SpanStyle =
      index === state.tab ? { bold: true } : answered ? { color: "success" } : { color: "muted" };
    spans.push(styled(`[${question.header}]`, style));
  }
  spans.push(styled(SPACE), styled("[Submit]", { color: "muted" }));
  return [...wrapSpans(spans, { width: context.width })];
}

/** One option's row: the pointer, the box its question's kind draws, its number and its label. */
function optionRow(question: ChoiceQuestion, index: number, state: ChoiceState, context: LayoutContext): StyledLine {
  const cursor = state.cursor === index;
  const chosen = state.selected[state.tab]?.includes(index) === true;
  const mark = question.multiSelect ? (chosen ? MULTI_ON : MULTI_OFF) : chosen ? SINGLE_ON : SINGLE_OFF;
  const option = question.options[index];
  const description = option?.description;
  return cutRow(
    [
      pointer(context, cursor),
      styled(mark),
      styled(`${index + 1}. ${option?.label ?? ""}`, cursor ? { bold: true } : {}),
      ...(description === undefined ? [] : [styled(`${DESCRIPTION_GAP}${description}`, { color: "muted" })]),
    ],
    context,
  );
}

/** The `Other...` row: the free-text answer as it stands, whether stored or being typed. */
function otherRow(question: ChoiceQuestion, state: ChoiceState, context: LayoutContext): StyledLine {
  const cursor = state.cursor === question.options.length;
  const stored = state.editing ? state.draft : state.other[state.tab];
  const text = stored === undefined || stored === "" ? "" : `${SPACE}${stored}`;
  return cutRow(
    [
      pointer(context, cursor),
      styled(OTHER_LABEL, cursor ? { bold: true } : {}),
      ...(text === "" ? [] : [styled(text, { color: "muted" })]),
    ],
    context,
  );
}

/** Every row the current question offers, in the order the pointer moves through them. */
function optionListRows(question: ChoiceQuestion, state: ChoiceState, context: LayoutContext): StyledLine[] {
  const options = question.options.map((_option, index) => optionRow(question, index, state, context));
  return question.allowOther ? [...options, otherRow(question, state, context)] : options;
}

/** The review step's rows: each question's header, then the line its answer reads as. */
function reviewRows(model: AskCardChoiceQuestion, state: ChoiceState, context: LayoutContext): StyledLine[] {
  return model.questions.flatMap((question, tab) => [
    cutRow([styled(question.header, { bold: true })], context),
    cutRow([styled(formatChoiceAnswers([question], [answerOf(state, tab)]))], context),
  ]);
}

/** The hint row's words: what the keys do in the state the card is in. */
function hintText(question: ChoiceQuestion, state: ChoiceState, multiTab: boolean): string {
  if (state.editing) return `${HINT_EDITING}${HINT_SEPARATOR}${HINT_DECLINE}`;
  if (state.review) return `${HINT_REVIEW}${HINT_SEPARATOR}${HINT_DECLINE}`;
  const parts = [question.multiSelect ? HINT_MULTI : HINT_SINGLE];
  if (question.allowOther) parts.push(HINT_OTHER);
  if (multiTab) parts.push(HINT_TABS);
  parts.push(HINT_DECLINE);
  return parts.join(HINT_SEPARATOR);
}

/** The hint row the card draws under its body, wrapped as every other card text is. */
function hintRows(
  question: ChoiceQuestion,
  state: ChoiceState,
  multiTab: boolean,
  context: LayoutContext,
): StyledLine[] {
  return textRows(hintText(question, state, multiTab), { color: "muted" }, context);
}

/** One `(n more ...)` row: cut to the width like every other row, so a marker is one row. */
function markerRow(count: number, text: string, context: LayoutContext): StyledLine {
  return elideSpansEnd([styled(`(${count} ${text})`, { color: "muted" })], context.width, ellipsis(context));
}

/** A window over a list of rows: the rows it draws, and how many of the list it withheld. */
interface RowWindow {
  readonly rows: readonly StyledLine[];
  readonly elided: number;
}

/** Where a window of `count` rows starts so `cursor` sits as near its middle as it can. */
function windowStart(total: number, count: number, cursor: number): number {
  const centred = cursor - Math.floor((count - 1) / 2);
  return Math.min(Math.max(centred, 0), Math.max(total - count, 0));
}

/**
 * The rows a window of at most `budget` rows draws over `list`, keeping `cursor` visible and
 * naming what it withheld. The widest window whose rows and markers fit wins, so a card with
 * room for one option and one marker draws exactly that rather than a lone row.
 */
function windowRows(list: readonly StyledLine[], budget: number, cursor: number, context: LayoutContext): RowWindow {
  const total = list.length;
  if (total === 0) return { rows: [], elided: 0 };
  if (budget >= total) return { rows: list, elided: 0 };
  if (budget <= 0) return { rows: [], elided: total };
  for (let count = budget; count >= 1; count -= 1) {
    const start = windowStart(total, count, cursor);
    const above = start;
    const below = total - start - count;
    const markers = (above > 0 ? ONE_MARKER_ROW : 0) + (below > 0 ? ONE_MARKER_ROW : 0);
    if (count + markers > budget) continue;
    return {
      rows: [
        ...(above > 0 ? [markerRow(above, MORE_ABOVE, context)] : []),
        ...list.slice(start, start + count),
        ...(below > 0 ? [markerRow(below, MORE_BELOW, context)] : []),
      ],
      elided: total - count,
    };
  }
  const row = list[Math.min(Math.max(cursor, 0), total - 1)];
  return { rows: row === undefined ? [] : [row], elided: total - 1 };
}

/** What the body drew: the question's own rows, and the window under them. */
interface BodyRows {
  readonly questionRows: readonly StyledLine[];
  readonly middle: readonly StyledLine[];
  readonly elided: number;
}

/** The body at the room it has left: the review list, or the question and its options. */
function bodyRows(
  model: AskCardChoiceQuestion,
  state: ChoiceState,
  question: ChoiceQuestion | undefined,
  context: LayoutContext,
  room: number,
): BodyRows {
  if (state.review) {
    const window = windowRows(reviewRows(model, state, context), room, 0, context);
    return { questionRows: [], middle: window.rows, elided: window.elided };
  }
  if (question === undefined) return { questionRows: [], middle: [], elided: 0 };
  const questionAll = textRows(question.question, {}, context);
  const list = optionListRows(question, state, context);
  const fits = questionAll.length + list.length <= room;
  const questionRows = fits || questionAll.length <= 1 ? questionAll : [elidedRow(question.question, {}, context)];
  const window = windowRows(list, Math.max(room - questionRows.length, 0), state.cursor, context);
  return { questionRows, middle: window.rows, elided: window.elided };
}

/**
 * Every row the card draws at a width and a budget. The prompt keeps its rows while they fit
 * and is cut to one marked row before anything else is given up; the frame, the title, the tab
 * strip, the question line, the hint and the countdown are never withheld.
 *
 * The rows returned never outnumber the rows reserved, whatever budget it is handed: a budget
 * below the card's own minimum — which the frame allocator never gives, but a constrained
 * caller can — keeps the top of the card and nothing more (see `clipToBudget`).
 */
export function choiceQuestionLayout(
  model: AskCardChoiceQuestion,
  state: ChoiceState,
  options: ChoiceQuestionLayoutOptions,
): ChoiceQuestionLayout {
  const context = contextFor(options);
  const budget = rowBudget(options.budget);
  const question = currentQuestion(model, state);
  const head: StyledLine[] = [
    frameRule(context, model.border),
    ...textRows(model.title, { bold: true }, context),
    ...tabStripRows(model, state, context),
  ];
  const tail: StyledLine[] = [
    ...(question === undefined ? [] : hintRows(question, state, model.questions.length >= 2, context)),
    ...countdownRows(options.expiresAt, options.nowMs ?? _askCardDeps.now(), context),
    frameRule(context, model.border),
  ];
  // What the prompt and the body may have: whatever the frame, the title, the strip and the tail left.
  const room = budget - head.length - tail.length;
  const promptAll = model.prompt === "" ? [] : textRows(model.prompt, {}, context);
  const prompt = promptAll.length <= room ? promptAll : room >= 1 ? [elidedRow(model.prompt, {}, context)] : [];
  head.push(...prompt);
  const body = bodyRows(model, state, question, context, Math.max(room - prompt.length, 0));
  head.push(...body.questionRows);
  return clipToBudget(head, body.middle, tail, body.elided, budget);
}

/**
 * The card's rows fitted to the rows reserved. A budget at or above the card's minimum never
 * reaches the trimming below — the prompt and the body already gave rows up — so the drawing is
 * returned as it stands. A budget smaller than the frame, the title, the hint and the countdown
 * *together* cannot honour "the hint and the countdown are never withheld" and "never more rows
 * than the budget" at once, and the budget is the caller's reservation: the card keeps the top
 * of itself — the frame rule, the title, the strip, then whatever else fits — and withholds the
 * rest, so nothing is ever drawn into a row nobody reserved.
 */
function clipToBudget(
  head: readonly StyledLine[],
  middle: readonly StyledLine[],
  tail: readonly StyledLine[],
  elided: number,
  budget: number,
): ChoiceQuestionLayout {
  const total = head.length + middle.length + tail.length;
  if (!Number.isFinite(budget) || total <= budget) return { head, middle, tail, elided, rows: total };
  const keptHead = head.slice(0, Math.min(head.length, budget));
  const roomForMiddle = Math.max(budget - keptHead.length, 0);
  const keptMiddle = middle.slice(0, Math.min(middle.length, roomForMiddle));
  const roomForTail = Math.max(roomForMiddle - keptMiddle.length, 0);
  const keptTail = tail.slice(0, Math.min(tail.length, roomForTail));
  return {
    head: keptHead,
    middle: keptMiddle,
    tail: keptTail,
    elided,
    rows: keptHead.length + keptMiddle.length + keptTail.length,
  };
}

/** Every state the card can be measured in: each tab, and the review step it ends on. */
function measuredStates(model: AskCardChoiceQuestion): readonly ChoiceState[] {
  const base = initialChoiceState(model.questions);
  const tabs = model.questions.map((_question, tab) => ({ ...base, tab }));
  return [...tabs, { ...base, review: true }];
}

/** The rows the card wants: the largest draw any of its states produces with no budget at all. */
function desiredRows(model: AskCardChoiceQuestion, options: ChoiceQuestionContentOptions): number {
  const drawn = measuredStates(model).map(
    (state) => choiceQuestionLayout(model, state, { ...options, budget: CHOICE_UNLIMITED_BUDGET }).rows,
  );
  return Math.max(0, ...drawn);
}

/**
 * The rows the card cannot be drawn in fewer of: both frame rules, the title, the tab strip
 * when it is shown, one question row, one option row, both window markers, the hint and the
 * countdown. It is what the frame allocator may not go below — the card draws a truncated
 * option window there, never a card with its question or its countdown missing.
 *
 * A card whose whole drawing is already that small — a two-option question with no prompt —
 * measures its floor as its `desired`: a minimum above what the card ever draws would make the
 * screen reserve a row nothing fills.
 */
export function choiceQuestionMeasurement(
  model: AskCardChoiceQuestion,
  options: ChoiceQuestionContentOptions,
): ChoiceQuestionMeasurement {
  const context = contextFor(options);
  const states = measuredStates(model);
  const state = states[0] ?? initialChoiceState([]);
  const tabRows = tabStripRows(model, state, context).length;
  const hint = Math.max(
    0,
    ...states.map((each) => {
      const question = currentQuestion(model, each);
      return question === undefined ? 0 : hintRows(question, each, model.questions.length >= 2, context).length;
    }),
  );
  const countdown = countdownRows(options.expiresAt, options.nowMs ?? _askCardDeps.now(), context).length;
  const floor =
    FRAME_RULE_ROWS * 2 +
    textRows(model.title, { bold: true }, context).length +
    tabRows +
    ONE_QUESTION_ROW +
    ONE_OPTION_ROW +
    ONE_MARKER_ROW * 2 +
    hint +
    countdown;
  const desired = desiredRows(model, options);
  return { minimum: Math.min(floor, desired), desired };
}
