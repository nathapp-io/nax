/**
 * Chat input — the controlled framed prompt at the bottom of the chat screen.
 *
 * The input owns no text of its own: its owner keeps an `InputDraft` (the line editor's
 * state, the submitted history and, while the user browses history, where they are in it)
 * and passes `draft` + `onDraftChange`. Unmounting the input while an ask card or a picker
 * takes over the bottom of the screen therefore loses neither the half-typed message nor
 * the history — the draft outlives the component.
 *
 * The frame is two full-width rule lines with the editor between them: the first text row
 * behind the accent `> ` marker and every later row behind two spaces, the cell under the
 * cursor drawn in inverse. At most `MAX_TEXT_ROWS` rows are shown and the window follows
 * the cursor, so a ten-line prompt keeps the line being typed in view. Text rows are drawn
 * whole rather than cut to the rule width — the frame is decoration, and truncating a
 * prompt to it would hide what the user is about to send.
 *
 * Keys: a printable chunk is inserted at the cursor (via the line editor, which also owns
 * backspace, the arrows, the word moves and the ctrl chords), return submits, up and down
 * walk the history. `yieldNavigation` hands up, down, return, tab and escape back to the
 * slash menu drawn beneath the input while it is open.
 */
import { Box, type Key, Text, useInput } from "ink";
import { type ReactElement, useEffect, useRef } from "react";
import { resolveWidth } from "./layout-lines";
import { cursorRow, type EditorState, EMPTY_EDITOR, editLine } from "./line-editor";
import { displayWidth, type Span, sanitizeText } from "./styled-line";
import type { ChatTheme } from "./theme";

/** The window the user is browsing, and the text to restore when they leave it. */
export interface InputBrowse {
  /** The index into `history` the editor currently shows a copy of. */
  readonly index: number;
  /** The editor as it stood before browsing started — restored past the newest entry. */
  readonly saved: EditorState;
}

/** Everything the input needs from its owner: the text, the history, and the browse position. */
export interface InputDraft {
  readonly editor: EditorState;
  readonly history: readonly string[];
  readonly browse?: InputBrowse;
}

/** A fresh draft: no text, no history, not browsing. */
export const EMPTY_DRAFT: InputDraft = { editor: EMPTY_EDITOR, history: [] };

/** How long after the first escape a second one still clears the input. */
export const DOUBLE_ESCAPE_MS = 2000;

/**
 * When the armed clear expires: one millisecond past the window, so an escape that lands
 * exactly `DOUBLE_ESCAPE_MS` after the first one still clears the input (the window is
 * inclusive) and only a later one is a fresh arm.
 */
const ARM_EXPIRY_MS = DOUBLE_ESCAPE_MS + 1;

/**
 * Injected seams. `now` times the clear-arm window and the timer expiry, so a test can
 * move the clock instead of waiting `DOUBLE_ESCAPE_MS` of real time. The timer is a plain
 * `setTimeout` rather than a sleep because its handle is cancelled mid-flight: by an early
 * clear, by a re-arm, and by unmount.
 */
export const _chatInputDeps = {
  now: (): number => Date.now(),
  setTimeout: (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number =>
    globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle: ReturnType<typeof setTimeout> | number): void => globalThis.clearTimeout(handle),
};

export interface ChatInputProps {
  readonly draft: InputDraft;
  readonly onDraftChange: (draft: InputDraft) => void;
  readonly onSubmit: (text: string) => void;
  /** The columns the rule lines span; below `MIN_LAYOUT_WIDTH` is treated as it. */
  readonly width: number;
  readonly theme: ChatTheme;
  readonly active?: boolean;
  readonly busy?: boolean;
  /** Shown in place of the placeholder while the editor is empty. */
  readonly hint?: string;
  /** The slash menu is open and owns up, down, return, tab and escape. */
  readonly yieldNavigation?: boolean;
  readonly onClearArmedChange?: (armed: boolean) => void;
}

/** The prompt an empty, idle input offers when its owner has no hint. */
const PLACEHOLDER = 'Try "explain how nax run picks a model" · / for commands';
const PROMPT_MARKER = "> ";
const CONTINUATION = "  ";
/** What the cursor draws at the end of a row, where there is no character to invert. */
const CURSOR_CELL = " ";
const SLASH = "/";
const NEWLINE = "\n";

/** The most text rows drawn before the window starts following the cursor. */
const MAX_TEXT_ROWS = 8;

/** A run of text and how to draw it. The cursor adds `inverse`, which `Span` has no slot for. */
type Cell = Span & { readonly inverse?: boolean };

interface FrameOptions {
  readonly draft: InputDraft;
  readonly theme: ChatTheme;
  readonly width: number;
  readonly active: boolean;
  readonly busy: boolean;
  readonly hint?: string;
}

/** One rule line: the theme's rule glyph, repeated to the laid-out width. */
function ruleLine(options: FrameOptions): readonly Cell[] {
  const glyph = options.theme.glyphs.rule;
  return [{ text: glyph.repeat(resolveWidth(options.width)), color: options.active ? "borderFocus" : "border" }];
}

/** The code-point index at which each display row of the text starts. */
function rowStarts(text: string): readonly number[] {
  const chars = Array.from(text);
  const starts = [0];
  for (let index = 0; index < chars.length; index++) {
    if (chars[index] === NEWLINE) starts.push(index + 1);
  }
  return starts;
}

/**
 * Splits text into user-perceived characters. A joined emoji — one that a zero-width joiner
 * builds out of several code points, like the technologist sequence — is **one** cell on
 * screen, so a cursor split has to treat it as one; `layout-lines.ts` and `wrap.ts` keep
 * their own instance for the same reason.
 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clusters(text: string): readonly string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (segment) => segment.segment);
}

/**
 * Split one row at a display column: text left of the cursor, the cell under it, the rest.
 * Widths are summed per grapheme cluster, which is how the row measures as a whole — summing
 * code points would find a two-column joined emoji to be four columns wide and leave the
 * cursor inside it.
 */
function splitAtCursor(displayed: string, column: number): { head: string; cell: string; tail: string } {
  const cells = clusters(displayed);
  let head = "";
  let width = 0;
  let index = 0;
  while (index < cells.length && width + displayWidth(cells[index]) <= column) {
    head += cells[index];
    width += displayWidth(cells[index]);
    index++;
  }
  return { head, cell: cells[index] ?? CURSOR_CELL, tail: cells.slice(index + 1).join("") };
}

/**
 * The cursor's column in **display** columns: the source row up to the cursor, sanitised the
 * way the row is drawn, then measured. A code-point offset is not a column — a CJK
 * character or an emoji is two columns wide, a tab is drawn as two spaces and a stripped
 * control byte as none — so measuring the drawn prefix is the only way the inverse cell
 * lands on the character the cursor is actually in front of.
 */
function cursorColumn(row: string, offset: number): number {
  const prefix = Array.from(row).slice(0, Math.max(offset, 0)).join("");
  return displayWidth(sanitizeText(prefix));
}

/**
 * One editor row: the marker on the editor's own first row and the indent on every later
 * one, the row's sanitised text, and the inverse cursor cell when this row holds the cursor.
 */
function editorRow(text: string, index: number, cursorColumn: number | undefined): readonly Cell[] {
  const marker: Cell = index === 0 ? { text: PROMPT_MARKER, color: "accent" } : { text: CONTINUATION };
  const displayed = sanitizeText(text);
  if (cursorColumn === undefined) return [marker, { text: displayed }];
  const { head, cell, tail } = splitAtCursor(displayed, cursorColumn);
  return [marker, { text: head }, { text: cell, inverse: true }, { text: tail }];
}

/** The rows of an empty editor: the marker, then the muted placeholder or the owner's hint. */
function emptyRow(options: FrameOptions): readonly Cell[] {
  const marker: Cell = { text: PROMPT_MARKER, color: "accent" };
  if (options.busy) return [marker];
  return [marker, { text: options.hint ?? PLACEHOLDER, color: "muted" }];
}

/** The rows an editor of `rows` lines shows, the window sliding to keep the cursor's row. */
function visibleWindow(rows: readonly string[], cursorRowIndex: number): { start: number; rows: readonly string[] } {
  if (rows.length <= MAX_TEXT_ROWS) return { start: 0, rows };
  const start = Math.min(Math.max(cursorRowIndex - MAX_TEXT_ROWS + 1, 0), rows.length - MAX_TEXT_ROWS);
  return { start, rows: rows.slice(start, start + MAX_TEXT_ROWS) };
}

/** The editor's text rows for this frame. */
function textLines(options: FrameOptions): readonly (readonly Cell[])[] {
  const { editor } = options.draft;
  if (editor.text === "") return [emptyRow(options)];
  const source = editor.text.split(NEWLINE);
  const { row: cursorRowIndex } = cursorRow(editor);
  const offset = editor.cursor - rowStarts(editor.text)[cursorRowIndex];
  const window = visibleWindow(source, cursorRowIndex);
  return window.rows.map((text, index) => {
    const row = window.start + index;
    return editorRow(text, row, row === cursorRowIndex ? cursorColumn(source[cursorRowIndex], offset) : undefined);
  });
}

function cellProps(cell: Cell, theme: ChatTheme) {
  return {
    color: cell.color === undefined ? undefined : theme.colors[cell.color],
    backgroundColor: cell.background === undefined ? undefined : theme.colors[cell.background],
    bold: cell.bold,
    italic: cell.italic,
    inverse: cell.inverse,
  };
}

/** One drawn row: its cells, each with its own style. */
function Row({ cells, theme }: { readonly cells: readonly Cell[]; readonly theme: ChatTheme }): ReactElement {
  return (
    <Text>
      {cells
        .filter((cell) => cell.text !== "")
        .map((cell, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a row is an immutable value, re-rendered whole; cell order never changes.
          <Text key={index} {...cellProps(cell, theme)}>
            {cell.text}
          </Text>
        ))}
    </Text>
  );
}

/** The keys the slash menu owns while it is open under the input. */
function ownsNavigation(key: Key): boolean {
  return key.return || key.upArrow || key.downArrow || key.tab || key.escape;
}

/** An editor holding `text` with the cursor at its end — what recalling a history entry shows. */
function atEnd(text: string): EditorState {
  return { text, cursor: Array.from(text).length };
}

/**
 * The draft showing history entry `index`, remembering the text browsing started from the
 * first time so that stepping past the newest entry puts it back.
 */
function recalled(draft: InputDraft, index: number): InputDraft {
  const saved = draft.browse?.saved ?? draft.editor;
  return { editor: atEnd(draft.history[index]), history: draft.history, browse: { index, saved } };
}

/**
 * Up on the editor's first row walks one entry older; anything else (a cursor further
 * down, no history, already at the oldest entry) leaves the key to nobody.
 */
function previousEntry(draft: InputDraft): InputDraft | undefined {
  if (draft.history.length === 0 || cursorRow(draft.editor).row !== 0) return undefined;
  const index = draft.browse === undefined ? draft.history.length - 1 : draft.browse.index - 1;
  return index < 0 ? undefined : recalled(draft, index);
}

/**
 * Down on the editor's last row walks one entry newer. Past the newest entry it restores
 * the text that was there before browsing and forgets the browse position.
 */
function nextEntry(draft: InputDraft): InputDraft | undefined {
  const { browse, history } = draft;
  if (browse === undefined || history.length === 0) return undefined;
  const { row, rows } = cursorRow(draft.editor);
  if (row !== rows - 1) return undefined;
  const index = browse.index + 1;
  return index < history.length ? recalled(draft, index) : { editor: browse.saved, history };
}

/** An edit's draft: the new state, and the browse position dropped once the text changed. */
function edited(draft: InputDraft, editor: EditorState): InputDraft {
  return { editor, history: draft.history, browse: editor.text === draft.editor.text ? draft.browse : undefined };
}

/**
 * The framed chat prompt. It reports every edit through `onDraftChange` and never holds
 * text itself, so the owner decides when the input is shown at all.
 */
export function ChatInput({
  draft,
  onDraftChange,
  onSubmit,
  width,
  theme,
  active = true,
  busy = false,
  hint,
  yieldNavigation = false,
  onClearArmedChange,
}: ChatInputProps): ReactElement {
  const frame: FrameOptions = { draft, theme, width, active, busy, hint };
  /**
   * The newest draft, ahead of the owner's re-render. Two keys delivered in one batch both
   * run before the owner has re-rendered, so reducing the `draft` prop would make the
   * second key discard the first one's edit; every handler reduces `latest` instead and
   * writes it back before publishing.
   */
  const latest = useRef<InputDraft>(draft);
  latest.current = draft;
  /** When the clear was armed, on `_chatInputDeps.now`'s clock; undefined while disarmed. */
  const armedAt = useRef<number | undefined>(undefined);
  /** The armed clear's expiry — cancelled by an early clear, a re-arm and unmount. */
  const armExpiry = useRef<ReturnType<typeof _chatInputDeps.setTimeout> | undefined>(undefined);
  /** The owner's callback as of the latest render: an expiry fires long after it was armed. */
  const notifyClearArmed = useRef(onClearArmedChange);
  notifyClearArmed.current = onClearArmedChange;

  /** Hand the owner the next draft and remember it for the next key in this batch. */
  const publish = (next: InputDraft): void => {
    latest.current = next;
    onDraftChange(next);
  };

  /**
   * Drop the armed clear and report the transition. Every way an arm ends — a clearing
   * escape, a submit, the window elapsing — goes through here, so the owner's hint can
   * never be left stale. Reporting only a change keeps a redundant escape from flapping it.
   */
  const disarm = (): void => {
    if (armExpiry.current !== undefined) {
      _chatInputDeps.clearTimeout(armExpiry.current);
      armExpiry.current = undefined;
    }
    const wasArmed = armedAt.current !== undefined;
    armedAt.current = undefined;
    if (wasArmed) notifyClearArmed.current?.(false);
  };

  /** Arm a clear, or re-stamp an expired one: the owner hears only the first transition. */
  const arm = (): void => {
    const alreadyArmed = armedAt.current !== undefined;
    if (armExpiry.current !== undefined) _chatInputDeps.clearTimeout(armExpiry.current);
    armedAt.current = _chatInputDeps.now();
    armExpiry.current = _chatInputDeps.setTimeout(disarm, ARM_EXPIRY_MS);
    if (!alreadyArmed) notifyClearArmed.current?.(true);
  };

  // A pending expiry must not outlive the input; the owner keeps the draft and its arm state.
  useEffect(() => {
    return () => {
      if (armExpiry.current === undefined) return;
      _chatInputDeps.clearTimeout(armExpiry.current);
      armExpiry.current = undefined;
    };
  }, []);

  /** Whitespace is not a message, and a running turn only accepts a slash command. */
  const submit = (text: string): void => {
    const current = latest.current;
    if (text.trim() === "") return;
    if (busy && !text.startsWith(SLASH)) return;
    disarm();
    publish({ editor: EMPTY_EDITOR, history: [...current.history, text] });
    onSubmit(text);
  };

  /**
   * Escape arms a clear, and a second escape inside `DOUBLE_ESCAPE_MS` empties the input.
   * Past the window the arm has expired (or is re-stamped), so the text survives.
   */
  const escapeKey = (): void => {
    const current = latest.current;
    if (busy || current.editor.text === "") return;
    const armed = armedAt.current;
    if (armed !== undefined && _chatInputDeps.now() - armed <= DOUBLE_ESCAPE_MS) {
      disarm();
      publish({ editor: EMPTY_EDITOR, history: current.history });
      return;
    }
    arm();
  };

  useInput(
    (input, key) => {
      if (yieldNavigation && ownsNavigation(key)) return;
      if (key.escape) {
        escapeKey();
        return;
      }
      const current = latest.current;
      if (key.upArrow) {
        const previous = previousEntry(current);
        if (previous !== undefined) publish(previous);
        return;
      }
      if (key.downArrow) {
        const next = nextEntry(current);
        if (next !== undefined) publish(next);
        return;
      }
      const result = editLine(current.editor, { input, key });
      if (result.kind === "submit") submit(result.text);
      else if (result.kind === "edit") publish(edited(current, result.state));
    },
    { isActive: active },
  );

  return (
    <Box flexDirection="column">
      <Row cells={ruleLine(frame)} theme={theme} />
      {textLines(frame).map((cells, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the editor's rows are positional; the row's own index is its identity.
        <Row key={index} cells={cells} theme={theme} />
      ))}
      <Row cells={ruleLine(frame)} theme={theme} />
    </Box>
  );
}
