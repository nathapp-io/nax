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
 * cursor drawn in inverse. At most `MAX_TEXT_ROWS` rows are shown (or fewer when the screen
 * has less room) and the window follows the cursor, so a ten-line prompt keeps the line being
 * typed in view. The rows are the input's own: it wraps each source line to the columns it is
 * drawn into and renders the pieces, so the height `inputRows` reports is the height on screen
 * — nothing is left for the terminal to wrap, and no prompt text is ever cut away.
 *
 * Keys: a printable chunk is inserted at the cursor (via the line editor, which also owns
 * backspace, the arrows, the word moves and the ctrl chords), return submits, up and down
 * walk the history — the bare arrows only, because a shifted arrow is the transcript
 * viewport's. `yieldNavigation` hands up, down, return, tab and escape back to the slash menu
 * drawn beneath the input while it is open, and the owner may hand over a claim to read at key
 * time instead of a flag, so a tab and the return after it — delivered before any re-render —
 * end up in the right hands. The input publishes a `ChatInputHandle` so the two keys the menu
 * keeps for itself — completing a name and running one — go through the same draft ref and the
 * same clear-arm this component owns, instead of the owner writing its state behind the
 * editor's back.
 */
import { Box, type Key, Text, useInput, useStdout } from "ink";
import { type ReactElement, type RefObject, useEffect, useRef } from "react";
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
  /**
   * A menu beneath the input — the slash menu or the mention picker — is open and owns up,
   * down, return, tab and escape. A boolean is the claim as of the last render; a function is
   * read at key time, so a batch that completes a name and then returns hands that return to
   * this editor rather than to the menu's stale row.
   */
  readonly yieldNavigation?: boolean | (() => boolean);
  /**
   * The owner's handle on the things a menu does to a line. They must go through the input,
   * not the owner's state: the draft the next keypress reduces lives in a ref this
   * component owns, and the clear-arm timer does too.
   */
  readonly handle?: RefObject<ChatInputHandle | undefined>;
  readonly onClearArmedChange?: (armed: boolean) => void;
  /** The most text rows the screen has room for; absent means the input's own cap. */
  readonly maxRows?: number;
}

/**
 * What the owner may ask the input to do for a line the slash menu or the mention picker
 * produced. The menu's tab and return bypass the editor, so they would otherwise skip its
 * bookkeeping — the draft ref a keypress in the same batch reduces, and the clear-arm a
 * submit disarms.
 */
export interface ChatInputHandle {
  /** Write a completed line into the prompt, cursor after it — what tab does. */
  complete(text: string): void;
  /**
   * Write an editor state into the prompt and leave the cursor where it says — what choosing
   * a mention row does, since the row replaces the token under the cursor rather than
   * appending to the line.
   */
  edit(state: EditorState): void;
  /** Submit a line exactly as return does: disarm the clear, empty the prompt, keep the history. */
  submit(text: string): void;
}

/** The prompt an empty, idle input offers when its owner has no hint. */
const PLACEHOLDER = 'Try "explain how nax run picks a model" · / for commands';
const PROMPT_MARKER = "> ";
const CONTINUATION = "  ";
/** What the cursor draws at the end of a row, where there is no character to invert. */
const CURSOR_CELL = " ";
const SLASH = "/";
const NEWLINE = "\n";

/** The most text rows drawn at once, however much room the screen has. */
const MAX_TEXT_ROWS = 8;

/** The two rule lines that frame the editor: one above it, one below. */
export const INPUT_RULE_ROWS = 2;

/** What the input needs to know about a frame to decide how many rows it draws. */
export interface InputRowsOptions {
  /** The columns the input is framed to; a text row wider than this wraps. */
  readonly width: number;
  /** True while a turn runs: an empty editor then draws its marker alone. */
  readonly busy?: boolean;
  /** Shown in place of the placeholder while the editor is empty. */
  readonly hint?: string;
  /**
   * The columns the input is actually drawn into. It is `width` inside the chat screen, but a
   * host may frame a narrower input in a wider container — the rows wrap to the container,
   * because that is what the terminal shows.
   */
  readonly container?: number;
  /** The most text rows the screen has room for; absent means the input's own cap. */
  readonly maxRows?: number;
}

/** Where a content row's text starts: behind the prompt marker, and past its indent after a wrap. */
const TEXT_INDENT = displayWidth(PROMPT_MARKER);

/** The columns a row's text occupies inside the frame, the marker already deducted. */
function frameColumns(width: number): number {
  return Math.max(1, resolveWidth(width) - TEXT_INDENT);
}

/** The columns a row's text may fill: the frame's, or the container's when it is wider. */
function layoutColumns(options: InputRowsOptions): number {
  const container = options.container === undefined ? 0 : options.container - TEXT_INDENT;
  return Math.max(1, frameColumns(options.width), container);
}

/** The most text rows this frame shows: the input's cap, or the screen's budget if smaller. */
function textRowCap(options: InputRowsOptions): number {
  return Math.max(1, Math.min(MAX_TEXT_ROWS, options.maxRows ?? MAX_TEXT_ROWS));
}

/** One literal space: the character a line prefers to break after. */
const BREAK_CHARACTER = " ";

/**
 * One source row split into the physical rows it fills. Every character is kept, spaces
 * included — a prompt's whitespace is content, and dropping it would make the measured height
 * disagree with what the terminal draws — and a line breaks after its last space where it has
 * one, so words are not cut in half; a single word wider than the line is cut at the line.
 * An empty row is one empty piece.
 */
function splitRow(text: string, columns: number): readonly string[] {
  const budget = Math.max(1, columns);
  const cells = clusters(text);
  const pieces: string[] = [];
  let index = 0;
  while (index < cells.length) {
    let used = 0;
    let end = index;
    let lastSpace = -1;
    while (end < cells.length) {
      const width = displayWidth(cells[end]);
      if (used + width > budget && end > index) break;
      used += width;
      end += 1;
      if (cells[end - 1] === BREAK_CHARACTER) lastSpace = end;
    }
    // A line breaks at its last space only when the budget stopped it there; a row that fits
    // whole stays whole.
    const overflowing = end < cells.length;
    const cut = overflowing && lastSpace > index ? lastSpace : end;
    pieces.push(cells.slice(index, cut).join(""));
    index = cut;
  }
  return pieces.length === 0 ? [""] : pieces;
}

/** The rows the placeholder or the owner's hint draws when the editor is empty. */
function emptyRows(options: InputRowsOptions): readonly TextRow[] {
  if (options.busy) return [{ text: "", marker: true }];
  const hint = sanitizeText(options.hint ?? PLACEHOLDER);
  return splitRow(hint, layoutColumns(options)).map((text, index) => ({
    text,
    marker: index === 0,
    muted: true,
  }));
}

/**
 * Every physical row of the draft, before the window: the placeholder when the editor is
 * empty, otherwise each source row wrapped at the columns left behind the prompt marker. The
 * row holding the cursor reserves one more column, because the inverse cursor cell is drawn
 * on top of it — without that column a draft that fills its row silently costs a rule line.
 * The cursor belongs to exactly one piece: the one whose span contains its column, or the last
 * one for the end-of-line cell.
 */
function pieceRows(draft: InputDraft, options: InputRowsOptions): readonly TextRow[] {
  const { editor } = draft;
  if (editor.text === "") return emptyRows(options);
  const columns = layoutColumns(options);
  const source = editor.text.split(NEWLINE);
  const { row: cursorRowIndex } = cursorRow(editor);
  const offset = editor.cursor - rowStarts(editor.text)[cursorRowIndex];
  const cursorAt = cursorColumn(source[cursorRowIndex], offset);
  const cursorLine = sanitizeText(source[cursorRowIndex]);
  const cursorAtEnd = cursorAt >= displayWidth(cursorLine);
  const rows: TextRow[] = [];
  for (const [index, line] of source.entries()) {
    const holdsCursor = index === cursorRowIndex;
    const budget = holdsCursor && cursorAtEnd ? Math.max(1, columns - 1) : columns;
    const pieces = splitRow(sanitizeText(line), budget);
    let start = 0;
    for (const [pieceIndex, text] of pieces.entries()) {
      const width = displayWidth(text);
      const last = pieceIndex === pieces.length - 1;
      // A piece owns the cursor only from its first column up to the next piece's first one;
      // the very last piece also owns the end-of-line cell past its text.
      const holds =
        holdsCursor && cursorAt >= start && (cursorAt < start + width || (last && cursorAt <= start + width));
      const cursor = holds ? Math.max(0, Math.min(cursorAt - start, width)) : undefined;
      rows.push({
        text,
        marker: index === 0 && pieceIndex === 0,
        ...(cursor === undefined ? {} : { cursor }),
      });
      start += width;
    }
  }
  return rows;
}

/**
 * The rows the input shows: every physical row while the draft fits the frame's cap, and
 * otherwise that many rows around the cursor — so a draft taller than the screen scrolls
 * under the viewport instead of pushing the footer off it. Each drawn row is already a piece
 * of the wrapped text, so it is narrower than the container and ink never re-wraps one.
 */
function visibleRows(draft: InputDraft, options: InputRowsOptions): readonly TextRow[] {
  const pieces = pieceRows(draft, options);
  const cap = textRowCap(options);
  if (pieces.length <= cap) return pieces;
  const holding = pieces.findIndex((row) => row.cursor !== undefined);
  const anchor = holding < 0 ? pieces.length - 1 : holding;
  const start = Math.min(Math.max(anchor - cap + 1, 0), pieces.length - cap);
  return pieces.slice(start, start + cap);
}

/**
 * The rows the input draws for a draft: the two rules around its text rows, counted after
 * wrapping and windowing. The screen's owner reserves exactly this many rows for the bottom
 * region, so a draft wider or taller than the terminal scrolls under the viewport instead of
 * pushing the footer off the screen.
 */
export function inputRows(draft: InputDraft, options: InputRowsOptions): number {
  return INPUT_RULE_ROWS + visibleRows(draft, options).length;
}

/** A run of text and how to draw it. The cursor adds `inverse`, which `Span` has no slot for. */
type Cell = Span & { readonly inverse?: boolean };

/** One row of the editor as it is drawn: the marker or the indent, and the text behind it. */
interface TextRow {
  readonly text: string;
  /** Draws the accent `> ` marker; every other row is indented past it. */
  readonly marker: boolean;
  /** Display column of the inverse cursor cell, on the one row that holds the cursor. */
  readonly cursor?: number;
  /** The placeholder or the owner's hint: drawn muted, and never carrying the cursor. */
  readonly muted?: boolean;
}

interface FrameOptions extends InputRowsOptions {
  readonly draft: InputDraft;
  readonly theme: ChatTheme;
  readonly active: boolean;
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
 * One drawn row: the marker on the editor's first row and the indent on every later one, the
 * row's text, and the inverse cursor cell when this row holds the cursor.
 */
function editorRow(row: TextRow): readonly Cell[] {
  const marker: Cell = row.marker ? { text: PROMPT_MARKER, color: "accent" } : { text: CONTINUATION };
  const displayed = sanitizeText(row.text);
  if (row.muted) return [marker, { text: displayed, color: "muted" }];
  if (row.cursor === undefined) return [marker, { text: displayed }];
  const { head, cell, tail } = splitAtCursor(displayed, row.cursor);
  return [marker, { text: head }, { text: cell, inverse: true }, { text: tail }];
}

/**
 * The editor's text rows for this frame: the rows `inputRows` counted, drawn. Each row is one
 * piece of the wrapped draft, so the rows the screen reserved are the rows on screen and ink
 * has nothing left to wrap.
 */
function textLines(options: FrameOptions): readonly (readonly Cell[])[] {
  return visibleRows(options.draft, options).map(editorRow);
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
  // A shifted key is never the menu's: shift+arrows scroll the transcript viewport, shift+tab
  // cycles the permission mode and shift+return is a newline in the prompt.
  if (key.shift) return false;
  return key.return || key.upArrow || key.downArrow || key.tab || key.escape;
}

/**
 * The history move a key asks for, or undefined when it asks for none. Only the bare arrows
 * browse: a shifted arrow is the transcript viewport's key, and answering it here as well
 * would replace a half-typed draft with a history entry while the transcript scrolled.
 */
function historyDirection(key: Key): "previous" | "next" | undefined {
  if (key.shift) return undefined;
  if (key.upArrow) return "previous";
  if (key.downArrow) return "next";
  return undefined;
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
  handle,
  onClearArmedChange,
  maxRows,
}: ChatInputProps): ReactElement {
  // The rows wrap to the container the input is drawn into, which is the terminal's width
  // rather than the frame's when a host frames a narrower prompt.
  const { stdout } = useStdout();
  const container = stdout.columns === undefined || stdout.columns <= 0 ? undefined : stdout.columns;
  const frame: FrameOptions = { draft, theme, width, active, busy, hint, container, maxRows };
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

  /** Write a line into the prompt with the cursor at its end — a completion, not a submit. */
  const complete = (text: string): void => {
    publish({ editor: atEnd(text), history: latest.current.history });
  };

  /**
   * Write an editor state into the prompt, cursor where it says — a mention row replaces the
   * token under the cursor, so the caret lands inside the line rather than after it.
   */
  const edit = (state: EditorState): void => {
    publish({ editor: state, history: latest.current.history });
  };

  /**
   * Whether the slash menu owns a navigation key right now. The owner may hand over a claim
   * to read instead of a flag, because the flag is the last render's: a tab and the return
   * after it can arrive before any re-render, and after that tab the prompt is no longer a
   * query, so the return is the editor's.
   */
  const yieldsNavigation = (): boolean => (typeof yieldNavigation === "function" ? yieldNavigation() : yieldNavigation);

  // The owner's handle is refreshed every render, so the callbacks it runs are this frame's:
  // a menu row completes, edits and runs through the same draft ref and the same clear-arm
  // that a typed key and a typed return use.
  if (handle !== undefined) handle.current = { complete, edit, submit };

  useInput(
    (input, key) => {
      if (ownsNavigation(key) && yieldsNavigation()) return;
      if (key.escape) {
        escapeKey();
        return;
      }
      const current = latest.current;
      const direction = historyDirection(key);
      if (direction !== undefined) {
        const browsed = direction === "previous" ? previousEntry(current) : nextEntry(current);
        if (browsed !== undefined) publish(browsed);
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
