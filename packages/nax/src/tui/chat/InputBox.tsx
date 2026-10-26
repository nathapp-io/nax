/**
 * The ask card's one-line text box — a controlled prompt the approval/question card edits.
 *
 * The box owns no text: the card keeps the answer and passes `value` + `onValueChange`, so the
 * rows the box will draw can be measured from the card's own state before the frame is laid
 * out. `inputBoxRows` is that measurement and the drawing both — the card renders the very
 * rows it counted, so a multi-line answer never grows the screen by a row the card forgot to
 * reserve.
 *
 * Every row is one terminal row: each source line is sanitised and wrapped into the columns
 * left behind the `> ` marker (`> ` before the first row, two spaces before the rest), so ink
 * never re-wraps a row and no answer text is cut away. `maxRows` windows the box to its newest
 * rows, which is what a card on a short terminal asks for.
 *
 * Keys are reduced against the newest text the box published, not the `value` prop: a chunk
 * of input — a paste, or a Return typed straight after the last character — is delivered
 * before the owner re-renders, so the prop is one key behind.
 */
import { Box, Text, useInput } from "ink";
import { type ReactElement, useRef } from "react";
import { resolveWidth, wrappedSource } from "./layout-lines";
import { displayWidth, sanitizeText } from "./styled-line";

export interface InputBoxProps {
  readonly busy: boolean;
  /** Disabled by the ask card while it does not own keyboard input. */
  readonly active?: boolean;
  readonly onSubmit: (message: string) => void;
  /** The text drawn and edited; the card keeps it so it can measure the card's rows. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** The columns the text is wrapped into — the card's own width. */
  readonly width: number;
  /** The most rows to draw; absent draws them all, and the newest rows always stay. */
  readonly maxRows?: number;
}

const PROMPT_MARKER = "> ";
/** What a wrapped source line and a later source line start with — as wide as the marker. */
const CONTINUATION = "  ";
const MARKER_WIDTH = displayWidth(PROMPT_MARKER);
const NEWLINE = "\n";

/**
 * The rows the box draws for `value`: the marker before the first row and two spaces before
 * every other, each source line wrapped into the columns left behind it. The ask card measures
 * with this same function, so the rows it reserves are exactly the rows on screen.
 */
export function inputBoxRows(value: string, width: number, maxRows?: number): readonly string[] {
  const columns = resolveWidth(width);
  const budget = Math.max(1, columns - MARKER_WIDTH);
  const rows: string[] = [];
  for (const [index, line] of sanitizeText(value).split(NEWLINE).entries()) {
    const prefix = index === 0 ? PROMPT_MARKER : CONTINUATION;
    for (const [pieceIndex, piece] of wrappedSource(line, budget).entries()) {
      rows.push(`${pieceIndex === 0 ? prefix : CONTINUATION}${piece}`);
    }
  }
  if (maxRows === undefined || rows.length <= Math.max(1, maxRows)) return rows;
  return rows.slice(rows.length - Math.max(1, maxRows));
}

export function InputBox({
  busy,
  active = true,
  onSubmit,
  value,
  onValueChange,
  width,
  maxRows,
}: InputBoxProps): ReactElement {
  /**
   * The newest text, ahead of the owner's re-render. Two keys delivered in one chunk — a
   * paste, or a Return typed straight after the last character — both run before the owner
   * has re-rendered, so editing the `value` prop would make the second key discard the
   * first one's edit and submit the text from before the chunk. Every handler edits `latest`
   * instead and writes it back before publishing.
   */
  const latest = useRef(value);
  latest.current = value;
  /** Hand the owner the next text and remember it for the next key in this batch. */
  const publish = (next: string): void => {
    latest.current = next;
    onValueChange(next);
  };

  useInput(
    (input, key) => {
      const current = latest.current;
      if (key.return) {
        if (key.meta) publish(`${current}\n`);
        else if ((!busy || current.startsWith("/")) && current.trim()) {
          publish("");
          onSubmit(current);
        }
      } else if (key.backspace || key.delete) publish(Array.from(current).slice(0, -1).join(""));
      else if (
        !key.ctrl &&
        !key.meta &&
        !key.escape &&
        !key.tab &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow
      ) {
        publish(current + input);
      }
    },
    { isActive: active },
  );
  return (
    <Box flexDirection="column">
      {inputBoxRows(value, width, maxRows).map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the box's rows are positional and redrawn whole.
        <Text key={index}>{row}</Text>
      ))}
    </Box>
  );
}
