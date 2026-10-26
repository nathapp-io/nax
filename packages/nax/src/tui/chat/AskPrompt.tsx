/**
 * The ask surface — the framed prompt an approval or a question replaces the input with,
 * and the model that measures it.
 *
 * `askPromptLayout` is the one place the card's rows are decided: it sanitises every text it
 * draws (a command or question carrying `\u001b[?1049l` cannot leave the alternate screen),
 * keeps the request's own line breaks as rows instead of folding them into spaces, wraps each
 * row to the card's width, and counts the question box's live answer through `inputBoxRows` —
 * the same function the box draws with. The screen composes with that count, so the card never
 * grows the frame by a row the layout did not reserve.
 *
 * A card taller than the rows the screen can spare loses its middle rather than its ends: the
 * options and the answer box are what the user must act on, and an elision line says how much
 * was withheld. `layout.head` and `layout.tail` are already fitted to the budget, so the
 * component draws exactly the rows that were measured.
 */
import { Box, Text, useInput } from "ink";
import type { ReactElement } from "react";
import type { ChatAskController, ChatPendingAsk } from "@/chat";
import { InputBox, inputBoxRows } from "./InputBox";
import { resolveWidth, textLines, wrappedSource } from "./layout-lines";
import type { ChatTheme } from "./theme";

export interface AskLayoutOptions {
  /** The columns the card is drawn into. */
  readonly width: number;
  /** Whether this ask may be remembered for the session — the second option appears when it may. */
  readonly canRemember: boolean;
  /** The question card's typed answer, which the box draws and the layout counts. */
  readonly answer: string;
  /** The rows the screen can give the whole card, the answer box included. */
  readonly budget: number;
}

/** The rows the card draws at a given width and budget. */
export interface AskPromptLayout {
  /** What the request is and why, already fitted to the budget. */
  readonly head: readonly string[];
  /** The rows a short screen must not lose: the sandbox note and the options. */
  readonly tail: readonly string[];
  /** The answer box's rows; 0 on an approval. */
  readonly input: number;
  /** How many rows the window dropped — one elision row names them. */
  readonly elided: number;
  /** Every row the card occupies: `head` + `tail` + the elision row + `input`. */
  readonly rows: number;
}

/** The single space a value is joined to its tool with. */
const SPACE = " ";
/** The extra row an approval outside the sandbox adds, assembled as `AskPrompt` draws it. */
const UNSANDBOXED_ASK = "outside the sandbox";
/** What an approval's option row reads, assembled exactly as it is drawn. */
const ALLOW_ONCE = "a: allow once";
const ALLOW_SESSION = " | s: allow for this session";
const DENY = " | d: deny";
/** The row that stands in for the rows a short screen withheld. */
const ELIDED_ONE = "1 more line";
const ELIDED_MANY = (count: number): string => `${count} more lines`;

/**
 * Every physical row a card text takes: sanitised, split on its own line breaks, then each
 * source line wrapped to the card's columns. A blank source line is one blank row — it is the
 * request's own formatting, not a wrap point — and an empty text is one empty row, as the one
 * `<Text>` the card draws for it always was.
 */
function textRows(text: string, columns: number): readonly string[] {
  const lines = textLines(text);
  const body = lines.length === 0 ? [""] : lines;
  return body.flatMap((line) => wrappedSource(line, columns));
}

/** The tool and, when it has one, the command it runs: what an approval identifies itself by. */
function commandText(ask: Extract<ChatPendingAsk, { type: "approval_requested" }>): string {
  return ask.command ? `${ask.tool}${SPACE}${ask.command}` : ask.tool;
}

/** The option row an approval draws, remembering included only when it is allowed. */
function choiceText(canRemember: boolean): string {
  return `${ALLOW_ONCE}${canRemember ? ALLOW_SESSION : ""}${DENY}`;
}

/**
 * Fit a card to the rows the screen can spare. The answer box is kept whole and the options
 * are kept before the identity rows, because those are what the user acts on; whatever is
 * dropped becomes one elision row between the two.
 */
function fitCard(card: {
  readonly head: readonly string[];
  readonly tail: readonly string[];
  readonly input: number;
  readonly budget: number;
}): AskPromptLayout {
  const body = card.head.length + card.tail.length;
  const room = Math.max(0, card.budget - card.input);
  if (body <= room) return { head: card.head, tail: card.tail, input: card.input, elided: 0, rows: body + card.input };
  // One row of the room names the rows that did not fit, so the user knows the card is cut.
  const keepTail = Math.min(card.tail.length, Math.max(0, room - 1));
  const keepHead = Math.max(0, room - keepTail - 1);
  const elided = card.head.length - keepHead + (card.tail.length - keepTail);
  const kept = keepHead + keepTail + (elided > 0 ? 1 : 0);
  return {
    head: card.head.slice(0, keepHead),
    tail: keepTail === 0 ? [] : card.tail.slice(card.tail.length - keepTail),
    input: card.input,
    elided,
    rows: kept + card.input,
  };
}

/**
 * The rows the card draws: a question's text above its answer box, or an approval's command,
 * reason, sandbox note and options — sanitised, wrapped and fitted to `budget`.
 */
export function askPromptLayout(ask: ChatPendingAsk, options: AskLayoutOptions): AskPromptLayout {
  const columns = resolveWidth(options.width);
  if (ask.type === "question") {
    // The box keeps one row of the card whatever else is dropped: it is where the answer goes.
    const input = inputBoxRows(options.answer, options.width, Math.max(1, options.budget - 1)).length;
    return fitCard({ head: textRows(ask.text, columns), tail: [], input, budget: options.budget });
  }
  const head = [...textRows(commandText(ask), columns), ...textRows(ask.reason, columns)];
  const tail: readonly string[] = [
    ...(ask.unsandboxed ? [UNSANDBOXED_ASK] : []),
    ...textRows(choiceText(options.canRemember), columns),
  ];
  return fitCard({ head, tail, input: 0, budget: options.budget });
}

/** The elision row's text: the glyph the theme draws an ellipsis with, then how much was cut. */
export function askElisionText(elided: number, theme: ChatTheme): string {
  const count = elided === 1 ? ELIDED_ONE : ELIDED_MANY(elided);
  return `${theme.glyphs.ellipsis} ${count}`;
}

export interface AskPromptProps {
  readonly ask: ChatPendingAsk;
  readonly controller: ChatAskController;
  /** The rows to draw — `askPromptLayout`'s, so the screen reserved exactly these. */
  readonly layout: AskPromptLayout;
  /** The question card's typed answer, owned by the screen so it can be measured. */
  readonly answer: string;
  readonly onAnswerChange: (answer: string) => void;
  readonly theme: ChatTheme;
  readonly width: number;
  readonly active?: boolean;
}

/** Only the first pending request owns input; remount for each request id. */
export function AskPrompt({
  ask,
  controller,
  layout,
  answer,
  onAnswerChange,
  theme,
  width,
  active = true,
}: AskPromptProps): ReactElement {
  const remember = ask.type === "approval_requested" && controller.canRemember(ask);
  useInput(
    (input, key) => {
      if (ask.type !== "approval_requested" || key.ctrl || key.meta) return;
      if (input === "a") controller.resolve(ask.requestId, "allow_once");
      else if (input === "s" && remember) controller.resolve(ask.requestId, "allow_session");
      else if (input === "d") controller.resolve(ask.requestId, "deny");
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column">
      {layout.head.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the card's rows are positional and redrawn whole.
        <Text key={`head-${index}`}>{row}</Text>
      ))}
      {layout.elided > 0 ? <Text>{askElisionText(layout.elided, theme)}</Text> : null}
      {layout.tail.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the card's rows are positional and redrawn whole.
        <Text key={`tail-${index}`}>{row}</Text>
      ))}
      {ask.type === "question" ? (
        <InputBox
          busy={false}
          active={active}
          value={answer}
          onValueChange={onAnswerChange}
          width={width}
          maxRows={Math.max(1, layout.input)}
          onSubmit={(text) => controller.answerQuestion(ask.requestId, text)}
        />
      ) : null}
    </Box>
  );
}
