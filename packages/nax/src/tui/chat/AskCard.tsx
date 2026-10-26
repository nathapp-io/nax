/**
 * The ask card — the framed approval or question that replaces the chat input while the
 * session waits for an answer.
 *
 * The card draws what the pure model (`ask-card.ts`) decided: the border, the title and its
 * attribution tag, the command and summary behind the card's three-column indent, the
 * reason, an Edit's diff drawn the way the tool card draws one, the numbered options with
 * the selection pointer on one of them, and the countdown. `askCardLayout` is the one place
 * the card's rows are decided — the screen measures the card with it to reserve exactly the
 * rows the card draws, so a long reason or a wide diff never pushes the footer off the
 * screen. A card taller than the rows the screen can spare loses the middle of its head and
 * an elision label names what it withheld; the options and the countdown are what the user
 * must act on, so they are kept.
 *
 * Keys have one owner here. An approval card owns escape (No), return (the selection), the
 * bare arrows (move the selection), the option's own number, and the `a` / `s` / `d`
 * shortcuts; a ctrl or meta chord does nothing, which is the rule the input has always had.
 * A question card owns none of them: the `ChatInput` inside it owns the typing keys and the
 * return that submits, exactly as the chat input does.
 *
 * The countdown is a `setTimeout` chain of `COUNTDOWN_TICK_MS`, cleared with `clearTimeout`
 * on unmount and once nothing is left to count; `setInterval` is not used because the
 * effect's cleanup could not stop a tick already queued. `_askCardDeps` carries that clock,
 * so a test moves time instead of waiting for it.
 */
import { Box, type Key, useInput } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import type { AskChoice, ChatAskController, ChatPendingAsk } from "@/chat";
import type { AskCardApproval, AskCardModel, AskCardQuestion, AskOption } from "./ask-card";
import { ChatInput, type InputDraft, inputRows } from "./ChatInput";
import {
  type LayoutContext,
  oneLine,
  prefixedLine,
  resolveWidth,
  resultPrefix,
  SPACE,
  type SpanStyle,
  styled,
  textLines,
} from "./layout-lines";
import { displayWidth, type Span, type StyledLine, StyledLineView } from "./styled-line";
import type { ChatColorToken, ChatTheme } from "./theme";
import type { DiffLine } from "./tool-card";

/** The delay between countdown redraws: one second, so `m:ss` never skips a value. */
export const COUNTDOWN_TICK_MS = 1000;
/** Under this many seconds left the countdown turns the theme's warning colour. */
export const COUNTDOWN_WARNING_SECONDS = 60;
/** The columns a command and a summary are indented by; a diff takes the tool card's own. */
const INDENT_COLUMNS = 3;
/** One second, in milliseconds: what the countdown divides the time left by. */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
/** A minute count of one digit, and a seconds count padded to two: `m:ss`. */
const SECONDS_PADDING = 2;
/** The label's own words; the count is what changes. */
const ELIDED_ONE = "1 more line";
/**
 * One empty line: what separates the card's title from what it is asking about. It carries a
 * space, because a row of no spans draws nothing at all — the row has to exist to be counted.
 */
const CARD_BLANK: StyledLine = [{ text: SPACE }];

/**
 * Injected seams. `now` reads the countdown's clock, and the timer pair is the chain that
 * re-renders it: a plain `setTimeout` rather than a sleep because its handle is cancelled
 * mid-flight, by unmount and by the countdown reaching zero.
 */
export const _askCardDeps = {
  now: (): number => Date.now(),
  setTimeout: (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: ReturnType<typeof setTimeout> | number): void => globalThis.clearTimeout(handle),
};

/** What the card's last row says, and the colour it says it in. */
export interface AskCountdown {
  readonly text: string;
  readonly color: "muted" | "warning";
}

/**
 * Whole seconds left until an ask expires: a timestamp that does not parse, or one already
 * behind the clock, leaves none. Every fixture in the suite stamps `at: "now"`, so an
 * unparseable expiry has to read as zero rather than as `NaN` seconds.
 */
function secondsLeft(expiresAt: string, nowMs: number): number {
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, Math.floor((expires - nowMs) / MS_PER_SECOND));
}

/** `m:ss` left, muted until the last minute and `warning` inside it. */
export function countdownLabel(expiresAt: string, nowMs: number): AskCountdown {
  const left = secondsLeft(expiresAt, nowMs);
  const minutes = Math.floor(left / SECONDS_PER_MINUTE);
  const seconds = String(left % SECONDS_PER_MINUTE).padStart(SECONDS_PADDING, "0");
  return {
    text: `expires in ${minutes}:${seconds}`,
    color: left < COUNTDOWN_WARNING_SECONDS ? "warning" : "muted",
  };
}

export interface AskCardLayoutOptions {
  /** The columns the card is drawn into. */
  readonly width: number;
  /** The rows the screen can give the whole card. */
  readonly budget: number;
  readonly theme: ChatTheme;
  /** The question card's own draft, which its input draws and this counts. */
  readonly answer: InputDraft;
  /** The ask's expiry, as the session reported it — the countdown row's text. */
  readonly expiresAt: string;
  /** The clock the countdown is read at; absent means `_askCardDeps.now()`. */
  readonly nowMs?: number;
  /**
   * The option the pointer is on. It changes no row's width — the pointer and the blank it
   * replaces are the same number of columns — so the screen can measure the card without
   * knowing which option the user has moved to.
   */
  readonly selected?: number;
}

/** The rows the card draws, already fitted to the rows the screen can spare. */
export interface AskCardLayout {
  /** Everything above the question box: the frame's top rule, the title and the ask itself. */
  readonly head: readonly StyledLine[];
  /** Everything below it: the options, the countdown and the frame's bottom rule. */
  readonly tail: readonly StyledLine[];
  /** The rows the question box may draw; 0 on an approval, which has no box. */
  readonly input: number;
  /** How many of the card's own rows were withheld — the elision label names them. */
  readonly elided: number;
  /** Every row the card occupies, `head` + `input` + `tail`. */
  readonly rows: number;
}

/** The card before it is fitted: its head, its tail, and the box the question adds. */
interface Card {
  readonly head: readonly StyledLine[];
  readonly tail: readonly StyledLine[];
}

/** The frame's rule: the theme's rule glyph across the card, in the ask's border tone. */
function ruleRow(theme: ChatTheme, columns: number, border: StyledLine[number]["color"]): StyledLine {
  return [styled(theme.glyphs.rule.repeat(columns), { color: border })];
}

/**
 * A card text's rows: sanitised, split on its own line breaks, then each source line wrapped
 * behind `prefix` — which every continuation row keeps, so a wrapped command stays indented.
 */
function textRows(text: string, prefix: StyledLine, style: SpanStyle, context: LayoutContext): readonly StyledLine[] {
  const source = textLines(text);
  const body = source.length === 0 ? [""] : source;
  return body.flatMap((physical) => prefixedLine([styled(physical, style)], prefix, context));
}

/** A card text's rows, or none when it says nothing: an absent summary is not a blank row. */
function optionalRows(
  text: string | undefined,
  prefix: StyledLine,
  style: SpanStyle,
  context: LayoutContext,
): readonly StyledLine[] {
  return text === undefined || text === "" ? [] : textRows(text, prefix, style, context);
}

/** The title, with the attribution tag a subagent's ask carries behind it. */
function titleRows(model: AskCardApproval, context: LayoutContext): readonly StyledLine[] {
  const title: Span = { text: model.title, bold: true };
  const tag: readonly Span[] = model.tag === undefined ? [] : [{ text: `${SPACE}${model.tag}`, color: "muted" }];
  return prefixedLine([title, ...tag], [], context);
}

/** A question's title: nax is the one asking. */
function questionTitleRows(model: AskCardQuestion, context: LayoutContext): readonly StyledLine[] {
  return prefixedLine([{ text: model.title, bold: true }], [], context);
}

/** The pointer and the blank that keeps an unselected option's number in the same column. */
function optionPrefix(theme: ChatTheme, chosen: boolean): StyledLine {
  const pointer = theme.glyphs.pointer;
  if (!chosen) return [styled(SPACE.repeat(displayWidth(pointer) + SPACE.length))];
  return [styled(`${pointer}${SPACE}`, { color: "accent" })];
}

/** One row per option, the number the card gives it and the pointer on the selected one. */
function optionRows(model: AskCardApproval, selected: number, context: LayoutContext): readonly StyledLine[] {
  return model.options.flatMap((option: AskOption, at: number) => {
    const chosen = at === selected;
    const text = `${option.index}. ${option.label}`;
    const style: SpanStyle = chosen ? { bold: true } : {};
    return prefixedLine([styled(text, style)], optionPrefix(context.theme, chosen), context);
  });
}

/**
 * A diff line's style: the theme's background band when it has one, and the tone's colour
 * when it does not — the rule `layout.ts` paints a tool card's diff by, so one replacement
 * text reads identically on the tool card and on the card that asks to make it.
 */
function diffStyle(sign: DiffLine["sign"], theme: ChatTheme): SpanStyle {
  if (sign === " ") return {};
  const background: ChatColorToken = sign === "-" ? "diffRemove" : "diffAdd";
  if (theme.colors[background] !== undefined) return { background };
  const color: ChatColorToken = sign === "-" ? "danger" : "success";
  return { color };
}

/** An Edit's diff, indented as far as the tool card indents its own. */
function diffRows(diff: readonly DiffLine[], context: LayoutContext): readonly StyledLine[] {
  const indent = SPACE.repeat(displayWidth(resultPrefix(context.theme)));
  return diff.flatMap((line) => {
    const style = diffStyle(line.sign, context.theme);
    return prefixedLine([styled(`${line.sign}${oneLine(line.text)}`, style)], [styled(indent, style)], context);
  });
}

/** The countdown row as the card draws it at `nowMs`. */
function countdownRow(expiresAt: string, nowMs: number): StyledLine {
  const countdown = countdownLabel(expiresAt, nowMs);
  return [styled(countdown.text, { color: countdown.color })];
}

/** An approval's rows: what it wants to run, why, what it would change, and the choices. */
function approvalBody(approval: AskCardApproval, options: AskCardLayoutOptions, context: LayoutContext): Card {
  const indent: StyledLine = [styled(SPACE.repeat(INDENT_COLUMNS))];
  return {
    head: [
      ruleRow(context.theme, context.width, approval.border),
      ...titleRows(approval, context),
      CARD_BLANK,
      ...optionalRows(approval.command, indent, { bold: true }, context),
      ...optionalRows(approval.summary, indent, { color: "muted" }, context),
      ...optionalRows(approval.reason, [], {}, context),
      ...diffRows(approval.diff, context),
    ],
    tail: [
      ...optionRows(approval, options.selected ?? 0, context),
      countdownRow(options.expiresAt, options.nowMs ?? _askCardDeps.now()),
      ruleRow(context.theme, context.width, approval.border),
    ],
  };
}

/** A question's rows: what nax asks, and the box the answer is typed into. */
function questionBody(model: AskCardQuestion, options: AskCardLayoutOptions, context: LayoutContext): Card {
  return {
    head: [
      ruleRow(context.theme, context.width, model.border),
      ...questionTitleRows(model, context),
      ...textRows(model.text, [], {}, context),
    ],
    tail: [
      countdownRow(options.expiresAt, options.nowMs ?? _askCardDeps.now()),
      ruleRow(context.theme, context.width, model.border),
    ],
  };
}

/** The elision label: the theme's ellipsis, then how many of the card's rows were withheld. */
function elisionRows(elided: number, context: LayoutContext): readonly StyledLine[] {
  const count = elided === 1 ? ELIDED_ONE : `${elided} more lines`;
  return textRows(`${context.theme.glyphs.ellipsis} ${count}`, [], { color: "muted" }, context);
}

/**
 * Fit the card to the rows the screen can spare: the question's box and the tail — the
 * options and the countdown, which the user must act on — are kept, and the head gives up
 * its last rows to an elision label until the card fits.
 */
function fitCard(card: Card, input: number, budget: number, context: LayoutContext): AskCardLayout {
  const room = budget - input - card.tail.length;
  if (card.head.length <= room) {
    return { head: card.head, tail: card.tail, input, elided: 0, rows: card.head.length + input + card.tail.length };
  }
  if (room <= 0) {
    return { head: [], tail: card.tail, input, elided: card.head.length, rows: input + card.tail.length };
  }
  // The label is a row of its own, and it wraps on a narrow card; it is measured at the
  // widest count it could carry, so the reservation never comes up a row short.
  const reserve = elisionRows(card.head.length, context).length;
  const kept = Math.max(0, room - reserve);
  const elided = card.head.length - kept;
  const head = [...card.head.slice(0, kept), ...(elided === 0 ? [] : elisionRows(elided, context))];
  return { head, tail: card.tail, input, elided, rows: head.length + input + card.tail.length };
}

/**
 * The rows the card draws at a given width and budget: an approval's identity, reason, diff
 * and options, or a question's text above the box its answer is typed into.
 */
export function askCardLayout(model: AskCardModel, options: AskCardLayoutOptions): AskCardLayout {
  const context: LayoutContext = { width: resolveWidth(options.width), theme: options.theme, expanded: false };
  const budget = Math.max(1, Math.floor(options.budget));
  const card =
    model.kind === "question" ? questionBody(model, options, context) : approvalBody(model, options, context);
  if (model.kind !== "question") return fitCard(card, 0, budget, context);
  // The box keeps at least one row, and never so many that the frame's own rules are cut.
  const maxRows = Math.max(1, budget - card.tail.length - 1);
  const input = inputRows(options.answer, { width: options.width, container: options.width, maxRows });
  return fitCard(card, input, budget, context);
}

export interface AskCardProps {
  readonly ask: ChatPendingAsk;
  /** The pure model for this ask: `askCardModel`'s approval or question card. */
  readonly model: AskCardModel;
  readonly controller: ChatAskController;
  /** The columns the card is drawn into. */
  readonly width: number;
  /** The rows the screen can give the whole card. */
  readonly budget: number;
  readonly theme: ChatTheme;
  /** The question card's typed answer — its own draft, never the chat input's. */
  readonly answer: InputDraft;
  readonly onAnswerChange: (draft: InputDraft) => void;
  /** Reports a No, so the screen can free the input to say what to do instead. */
  readonly onDeclined?: () => void;
  readonly active?: boolean;
}

/**
 * The key that chose an option, or undefined when the key chose none. A number key
 * addresses an option by the number the card drew beside it, and `a` / `s` / `d` are the
 * shortcuts an approval has always answered to — none of them while ctrl or meta is held.
 */
function chosenOption(input: string, key: Key, options: readonly AskOption[], selected: number): AskChoice | undefined {
  if (key.return) return options[selected]?.choice;
  if (key.ctrl || key.meta) return undefined;
  const numbered = options.find((option) => String(option.index) === input);
  if (numbered !== undefined) return numbered.choice;
  if (input === "a") return "allow_once";
  if (input === "s") return options.some((option) => option.choice === "allow_session") ? "allow_session" : undefined;
  if (input === "d") return "deny";
  return undefined;
}

/**
 * The framed ask card. It draws exactly the rows `askCardLayout` measured, resolves the ask
 * through the screen's controller, and reports a No so the screen can hint what to type
 * instead.
 */
export function AskCard({
  ask,
  model,
  controller,
  width,
  budget,
  theme,
  answer,
  onAnswerChange,
  onDeclined,
  active = true,
}: AskCardProps): ReactElement {
  const [nowMs, setNowMs] = useState<number>(() => _askCardDeps.now());
  const [selected, setSelected] = useState(0);
  const options = model.kind === "approval" ? model.options : [];

  // The countdown's clock: a `setTimeout` chain, cancelled on unmount and once nothing is
  // left to count. `setInterval` cannot be stopped by the cleanup before its next tick fires.
  useEffect(() => {
    let handle: ReturnType<typeof _askCardDeps.setTimeout> | undefined;
    let live = true;
    const tick = (): void => {
      const now = _askCardDeps.now();
      setNowMs(now);
      if (!live || secondsLeft(ask.expiresAt, now) === 0) return;
      handle = _askCardDeps.setTimeout(tick, COUNTDOWN_TICK_MS);
    };
    if (secondsLeft(ask.expiresAt, _askCardDeps.now()) > 0) handle = _askCardDeps.setTimeout(tick, COUNTDOWN_TICK_MS);
    return () => {
      live = false;
      if (handle !== undefined) _askCardDeps.clearTimeout(handle);
    };
  }, [ask.expiresAt]);

  const choose = (choice: AskChoice): void => {
    controller.resolve(ask.requestId, choice);
    if (choice === "deny") onDeclined?.();
  };

  useInput(
    (input, key) => {
      if (model.kind !== "approval") return;
      // ink reports a lone escape as `escape` *and* `meta`, so escape is taken first: the
      // ctrl/meta rule below is about letters, which must never answer an approval.
      if (key.escape) {
        choose("deny");
        return;
      }
      const choice = chosenOption(input, key, options, selected);
      if (choice !== undefined) {
        choose(choice);
        return;
      }
      // A shifted arrow belongs to the transcript viewport, which keeps it in every state.
      if (key.shift) return;
      if (key.upArrow) setSelected((current) => Math.max(0, current - 1));
      else if (key.downArrow) setSelected((current) => Math.min(options.length - 1, current + 1));
    },
    { isActive: active },
  );

  const layout = askCardLayout(model, { width, budget, theme, answer, expiresAt: ask.expiresAt, nowMs, selected });
  return (
    <Box flexDirection="column">
      {layout.head.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the card's rows are positional and redrawn whole.
        <StyledLineView key={`head-${index}`} line={line} theme={theme} />
      ))}
      {model.kind === "question" ? (
        <ChatInput
          draft={answer}
          onDraftChange={onAnswerChange}
          onSubmit={(text) => controller.answerQuestion(ask.requestId, text)}
          width={width}
          theme={theme}
          active={active}
          maxRows={layout.input}
        />
      ) : null}
      {layout.tail.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the card's rows are positional and redrawn whole.
        <StyledLineView key={`tail-${index}`} line={line} theme={theme} />
      ))}
    </Box>
  );
}
