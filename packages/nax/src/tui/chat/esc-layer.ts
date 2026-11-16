/**
 * The top layer esc acts on, as data: what the screen is drawing over the turn, and what esc
 * would do to it. `topEscLayer` reads the screen's own facts — an ask card, a picker, the
 * mention picker or the slash menu, then a running turn — in the order they are drawn, so a
 * card always wins over the row beneath it. `escHintText` names that action for the footer and
 * the working line, so what the screen promises esc does and what the esc handlers do are read
 * from one answer and cannot disagree.
 *
 * Everything here is pure and reads no state of its own: the screen passes in what it drew
 * this frame, which keeps the hint in step with a batched key that precedes React's redraw.
 */
import type { PickerKind } from "./slash-commands";

/** The ask card the screen is drawing, in the three kinds the card has. */
export type EscAsk = "question" | "approval" | "choice";

/**
 * What esc acts on. `question` carries `stops` because closing the card also cancels the turn
 * when the chat session asked it, while an approval or a choice card never stops a turn. It
 * also carries the question's own `id` when the screen knows it: a card replaced by another
 * card of the same kind is a different escape target, never the one already armed.
 */
export type EscLayer =
  | { kind: "question"; stops: boolean; id?: string }
  | { kind: "approval" }
  | { kind: "choice" }
  | { kind: "picker"; picker: PickerKind }
  | { kind: "menu" }
  | { kind: "turn" }
  | { kind: "none" };

/** What the screen drew this frame. Anything left out is not drawn. */
export interface EscLayerInput {
  /** The ask card, which the screen draws over pickers and the input. */
  readonly ask?: EscAsk;
  /** Whether the chat session asked it — only then does closing the card cancel the turn. */
  readonly askFromSession?: boolean;
  /**
   * The open question's own request id. Two questions on the same layer are still two escape
   * targets, so the arm earned on one must never carry to the other.
   */
  readonly askId?: string;
  /** The picker drawn under the input, if one is open. */
  readonly picker?: PickerKind;
  /** The mention picker's esc claim: false while only its no-git diagnostic line is drawn. */
  readonly mentionShown?: boolean;
  /** Whether the slash menu is drawn with at least one row to close. */
  readonly menuShown?: boolean;
  /** Whether the turn is running *and* its keys can control it. */
  readonly turnRunning?: boolean;
}

/** What each picker's hint calls itself: the command the user typed to open it. */
const PICKER_HINTS: Readonly<Record<PickerKind, string>> = {
  model: "esc to close model picker",
  resume: "esc to close sessions",
  mode: "esc to close mode picker",
  effort: "esc to close effort picker",
  jobs: "esc to close jobs",
};

const ESC_CLOSE = "esc to close";
const ESC_CLOSE_AND_STOP = "esc to close and stop";
/** What the two destructive layers say once their first press has armed the second. */
const ESC_AGAIN_INTERRUPT = "esc again to interrupt";
const ESC_AGAIN_CLOSE_AND_STOP = "esc again to close and stop";
const ESC_DENY = "esc to deny";
const ESC_CANCEL = "esc to cancel";
const ESC_CLOSE_MENU = "esc to close menu";

/** A question card is on top whenever it is drawn; it stops the turn only when both hold. */
function questionLayer(input: EscLayerInput): EscLayer {
  const stops = input.askFromSession === true && input.turnRunning === true;
  // Only when the screen knows it: a layer built without an id stays exactly the two fields it
  // has always had, so the card and the arm are the same value they were before.
  return input.askId === undefined ? { kind: "question", stops } : { kind: "question", stops, id: input.askId };
}

/** The card layer for `ask`, or undefined when no card is drawn. */
function cardLayer(input: EscLayerInput): EscLayer | undefined {
  switch (input.ask) {
    case undefined:
      return undefined;
    case "question":
      return questionLayer(input);
    default:
      return { kind: input.ask };
  }
}

/**
 * The layer esc acts on: the ask card, then the picker, then the mention picker or the slash
 * menu, then a running turn, then nothing.
 */
export function topEscLayer(input: EscLayerInput): EscLayer {
  const card = cardLayer(input);
  if (card !== undefined) return card;
  if (input.picker !== undefined) return { kind: "picker", picker: input.picker };
  if (input.mentionShown === true || input.menuShown === true) return { kind: "menu" };
  return { kind: input.turnRunning === true ? "turn" : "none" };
}

/**
 * What esc does on `layer`, as the footer's and the working line's hint text. `undefined` for a
 * running turn and for nothing at all: those keep the existing busy and idle hints, which the
 * screens already compose.
 *
 * `armed` is the confirmed-escape gesture's own state (US-006): a running turn and a stopping
 * question both stop on a second press, so their hint names the second press once the first one
 * has armed it. Every other layer keeps its single-escape wording, armed or not.
 */
export function escHintText(layer: EscLayer, armed = false): string | undefined {
  switch (layer.kind) {
    case "question":
      if (!layer.stops) return ESC_CLOSE;
      return armed ? ESC_AGAIN_CLOSE_AND_STOP : ESC_CLOSE_AND_STOP;
    case "approval":
      return ESC_DENY;
    case "choice":
      return ESC_CANCEL;
    case "picker":
      return PICKER_HINTS[layer.picker];
    case "menu":
      return ESC_CLOSE_MENU;
    case "turn":
      return armed ? ESC_AGAIN_INTERRUPT : undefined;
    case "none":
      return undefined;
  }
}
