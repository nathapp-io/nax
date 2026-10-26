import type { Key } from "ink";

/**
 * The prompt text and where the cursor sits in it, as data.
 *
 * `cursor` is a **code-point index** into `text`, not a UTF-16 offset and not a display
 * column: `"a😀b"` is three code points, so the cursor after the emoji is `2` and a
 * backspace there removes the whole emoji. Every transformation works on
 * `Array.from(state.text)` for that reason — a slice of the raw string would cut a
 * surrogate pair in half.
 *
 * The reducer is pure, so the input component can render any state it is handed and the
 * key map can be tested without ink.
 */
export interface EditorState {
  readonly text: string;
  readonly cursor: number;
}

/** An empty prompt with the cursor at the start — the state a fresh input starts in. */
export const EMPTY_EDITOR: EditorState = { text: "", cursor: 0 };

/**
 * One keypress as ink's `useInput` reports it: `input` is the text the key produced (a
 * pasted chunk arrives whole and multi-character) and `key` carries the modifier flags.
 */
export type EditorKey = {
  input: string;
  key: Pick<
    Key,
    | "return"
    | "backspace"
    | "delete"
    | "leftArrow"
    | "rightArrow"
    | "ctrl"
    | "meta"
    | "shift"
    | "escape"
    | "tab"
    | "upArrow"
    | "downArrow"
  >;
};

/**
 * What one keypress did: `edit` for a new state, `submit` for a prompt the owner should
 * send, `ignored` for a key this reducer does not own.
 */
export type EditorResult =
  | { kind: "edit"; state: EditorState }
  | { kind: "submit"; text: string }
  | { kind: "ignored" };

const IGNORED: EditorResult = { kind: "ignored" };

const NEWLINE = "\n";
const CONTINUATION = "\\";

/** The text as code points, with the cursor clamped into `[0, length]`. */
function read(state: EditorState): { chars: string[]; cursor: number } {
  const chars = Array.from(state.text);
  return { chars, cursor: Math.min(Math.max(state.cursor, 0), chars.length) };
}

function edited(text: string, cursor: number): EditorResult {
  return { kind: "edit", state: { text, cursor } };
}

/** Whitespace separates words for the word moves and ctrl+w — line breaks included. */
function isSpace(char: string): boolean {
  return /^\s$/.test(char);
}

/** Replaces the code points in `[start, end)` with `replacement` and parks the cursor after it. */
function splice(state: EditorState, start: number, end: number, replacement: string[]): EditorResult {
  const { chars } = read(state);
  const from = Math.min(Math.max(start, 0), chars.length);
  const to = Math.min(Math.max(end, from), chars.length);
  const next = [...chars.slice(0, from), ...replacement, ...chars.slice(to)];
  return edited(next.join(""), from + replacement.length);
}

/**
 * Inserts `text` at the cursor. A paste arrives as one chunk and is inserted whole, and
 * CRLF / CR become LF so a pasted Windows or old-Mac line break is one newline.
 */
function insert(state: EditorState, text: string): EditorResult {
  const { chars, cursor } = read(state);
  const added = Array.from(text.replace(/\r\n/g, NEWLINE).replace(/\r/g, NEWLINE));
  return edited([...chars.slice(0, cursor), ...added, ...chars.slice(cursor)].join(""), cursor + added.length);
}

/** Deletes the code point before the cursor — what both backspace and forward-delete do. */
function deleteBefore(state: EditorState): EditorResult {
  const { cursor } = read(state);
  if (cursor === 0) return { kind: "edit", state };
  return splice(state, cursor - 1, cursor, []);
}

/** The index of the first code point of the line the cursor is on. */
function lineStart(chars: readonly string[], cursor: number): number {
  let index = cursor;
  while (index > 0 && chars[index - 1] !== NEWLINE) index--;
  return index;
}

/** The index of the newline that ends the cursor's line, or the end of the text. */
function lineEnd(chars: readonly string[], cursor: number): number {
  let index = cursor;
  while (index < chars.length && chars[index] !== NEWLINE) index++;
  return index;
}

/** The start of the word before the cursor, whitespace first skipped. */
function previousWord(chars: readonly string[], cursor: number): number {
  let index = cursor;
  while (index > 0 && isSpace(chars[index - 1])) index--;
  while (index > 0 && !isSpace(chars[index - 1])) index--;
  return index;
}

/** The end of the word after the cursor, whitespace first skipped. */
function nextWord(chars: readonly string[], cursor: number): number {
  let index = cursor;
  while (index < chars.length && isSpace(chars[index])) index++;
  while (index < chars.length && !isSpace(chars[index])) index++;
  return index;
}

/** Moves the cursor to `position`, leaving the text alone. */
function moveTo(state: EditorState, position: number): EditorResult {
  return edited(state.text, position);
}

/** ctrl+a / ctrl+e / ctrl+u / ctrl+k / ctrl+w; any other ctrl chord belongs to the host. */
function ctrlResult(state: EditorState, input: string): EditorResult {
  const { chars, cursor } = read(state);
  switch (input) {
    case "a":
      return moveTo(state, lineStart(chars, cursor));
    case "e":
      return moveTo(state, lineEnd(chars, cursor));
    case "u":
      return splice(state, lineStart(chars, cursor), cursor, []);
    case "k":
      return splice(state, cursor, lineEnd(chars, cursor), []);
    case "w":
      return splice(state, previousWord(chars, cursor), cursor, []);
    default:
      return IGNORED;
  }
}

/**
 * Return: meta or shift inserts a newline, a backslash right before the cursor becomes the
 * newline instead (line continuation), and every other return submits the text as it
 * stands — untrimmed, because the caller decides what whitespace means.
 */
function returnResult(state: EditorState, key: EditorKey["key"]): EditorResult {
  if (key.meta || key.shift) return insert(state, NEWLINE);
  const { chars, cursor } = read(state);
  if (cursor > 0 && chars[cursor - 1] === CONTINUATION) return splice(state, cursor - 1, cursor, [NEWLINE]);
  return { kind: "submit", text: state.text };
}

/**
 * Folds one keypress into the editor.
 *
 * Return and the editing keys win over the modifier, so an arrow key that arrives with
 * ctrl still moves rather than being swallowed. A ctrl chord this reducer does not define,
 * and escape, tab, up and down, are `ignored`: the input component owns history, the slash
 * menu and the clear-arm, so it needs to see those keys unconsumed.
 */
export function editLine(state: EditorState, input: EditorKey): EditorResult {
  const { key } = input;
  const { chars, cursor } = read(state);
  if (key.return) return returnResult(state, key);
  if (key.backspace || key.delete) return deleteBefore(state);
  if (key.leftArrow) return moveTo(state, key.meta ? previousWord(chars, cursor) : Math.max(cursor - 1, 0));
  if (key.rightArrow) return moveTo(state, key.meta ? nextWord(chars, cursor) : Math.min(cursor + 1, chars.length));
  if (key.ctrl) return ctrlResult(state, input.input);
  if (key.escape || key.tab || key.upArrow || key.downArrow) return IGNORED;
  if (input.input === "") return IGNORED;
  return insert(state, input.input);
}

/**
 * Where the cursor sits on screen: the zero-based row of the cursor and how many rows the
 * text occupies. A cursor on a newline is still on the row that newline ends, matching
 * ctrl+a / ctrl+e, which treat the newline as the end of its line.
 */
export function cursorRow(state: EditorState): { row: number; rows: number } {
  const { chars, cursor } = read(state);
  let row = 0;
  let rows = 1;
  for (let index = 0; index < chars.length; index++) {
    if (chars[index] !== NEWLINE) continue;
    rows++;
    if (index < cursor) row++;
  }
  return { row, rows };
}
