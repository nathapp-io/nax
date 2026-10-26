/**
 * Slash menu — the filtered command list the chat screen draws under its prompt while the
 * input holds a `/` query.
 *
 * Which items a query keeps, how many rows are drawn and which of them the window shows is
 * the model's (`slash-menu.ts`); this component draws them. The window is at most
 * `SLASH_MENU_MAX_ROWS` rows and follows the pointer, so a long catalogue — every built-in
 * plus a repository's own commands and skills — never pushes the footer off the screen.
 * `slashMenuRows` is what the screen measures to reserve the rows the menu occupies, so the
 * height it allocates is the height drawn: every row is one physical row, and a description
 * too wide for the terminal is cut rather than wrapped into rows nobody reserved.
 *
 * The menu owns five keys while it is open: up and down move the pointer (no wrap), tab
 * writes the selected name into the input with the space its arguments follow, return runs
 * exactly that name, and escape puts the menu away and leaves the query the user typed.
 * Nothing else. pageUp, pageDown, home, end and the shifted arrows stay with the transcript
 * viewport, ctrl combinations stay with the screen and `useChatKeys`, and typing stays with
 * the input. A shifted key is never the menu's, so shift+up still scrolls the transcript and
 * shift+tab still cycles the permission mode.
 *
 * The pointer is placed by the query: a new query is a new list, so the pointer starts on its
 * first match. The newest pointer is kept in a ref as well as in the state, because two keys
 * delivered in one batch both run before the re-render that would show the first one's move —
 * and a return in that batch would otherwise run the row the menu no longer shows.
 */
import { Box, type Key, useInput } from "ink";
import { type ReactElement, useRef, useState } from "react";
import { resolveWidth, SPACE, styled } from "./layout-lines";
import { type SlashMenuItem, type SlashMenuQueryState, type SlashMenuWindow, slashMenuWindow } from "./slash-menu";
import { displayWidth, type Span, type StyledLine, StyledLineView } from "./styled-line";
import type { ChatTheme } from "./theme";
import { cutSpans } from "./wrap";

/** The columns between a command's name and its description — the gap `/help` uses. */
const NAME_GAP = "  ";

/** The first match's index, and where the pointer starts for every query. */
const FIRST_MATCH = 0;

/** The pointer's own columns: the glyph and a space, or the blank that keeps names aligned. */
function pointerPrefix(theme: ChatTheme, chosen: boolean): Span {
  const pointer = theme.glyphs.pointer;
  if (!chosen) return styled(SPACE.repeat(displayWidth(pointer) + SPACE.length));
  return styled(`${pointer}${SPACE}`, { color: "accent" });
}

/** One row: the pointer or its blank, `/name`, and the description, cut at the terminal. */
function menuRow(item: SlashMenuItem, chosen: boolean, width: number, theme: ChatTheme): StyledLine {
  const name = styled(`/${item.name}`, chosen ? { bold: true } : {});
  const description = styled(`${NAME_GAP}${item.description}`, { color: "muted" });
  return cutSpans([pointerPrefix(theme, chosen), name, description], width);
}

export interface SlashMenuLayoutOptions {
  /** The columns the menu is drawn into. */
  readonly width: number;
  readonly theme: ChatTheme;
  /** The match the pointer is on, as the screen tracked it; clamped to the matches it has. */
  readonly selected?: number;
}

/** The rows the menu draws for one query, already windowed around the pointer. */
export interface SlashMenuLayout {
  /** The pointer's row, clamped to the matches. */
  readonly selected: number;
  /** The index of the first match drawn. */
  readonly first: number;
  /** Every row the menu occupies — `lines.length`, and at most `SLASH_MENU_MAX_ROWS`. */
  readonly rows: number;
  readonly lines: readonly StyledLine[];
}

/** The window of an empty menu: no rows, and nothing withheld. */
const NO_WINDOW: SlashMenuWindow = { first: FIRST_MATCH, rows: 0 };

/** The rows the menu draws at a given width: the window around the pointer, one row each. */
export function slashMenuLayout(matches: readonly SlashMenuItem[], options: SlashMenuLayoutOptions): SlashMenuLayout {
  const selected = Math.min(Math.max(options.selected ?? FIRST_MATCH, FIRST_MATCH), matches.length - 1);
  const drawn = matches.length === 0 ? NO_WINDOW : slashMenuWindow(matches.length, selected);
  const width = resolveWidth(options.width);
  const lines = matches
    .slice(drawn.first, drawn.first + drawn.rows)
    .map((item, at) => menuRow(item, drawn.first + at === selected, width, options.theme));
  return { selected, first: drawn.first, rows: lines.length, lines };
}

/** Where the pointer is, and which query's list it was placed in. */
interface MenuSelection {
  readonly query: string;
  readonly index: number;
}

export interface SlashMenuProps {
  /** What the screen's query state decided: the matches drawn, and whether they are shown. */
  readonly menu: SlashMenuQueryState;
  readonly width: number;
  readonly theme: ChatTheme;
  /** False while another surface — an ask card, a picker — owns the keys. */
  readonly active?: boolean;
  /** Tab: the name becomes the input's text, with the space its arguments follow. */
  readonly onComplete: (name: string) => void;
  /** Return: the screen runs exactly this name. */
  readonly onRun: (name: string) => void;
  /** Escape: the query stays, the menu goes. */
  readonly onClose: () => void;
}

/** The keys the menu owns, and no others. */
function ownsMenuKey(key: Key): boolean {
  return Boolean(key.escape || key.tab || key.return || key.upArrow || key.downArrow);
}

/**
 * The filtered list under the chat input. It draws the rows `slashMenuLayout` decides and
 * hands the selected name to the screen for the two keys that act on it.
 */
export function SlashMenu({
  menu,
  width,
  theme,
  active = true,
  onComplete,
  onRun,
  onClose,
}: SlashMenuProps): ReactElement {
  const matches = menu.matches ?? [];
  const [selection, setSelection] = useState<MenuSelection>({ query: menu.query, index: FIRST_MATCH });
  /** The newest pointer, ahead of the re-render two keys in one batch would share. */
  const latest = useRef<MenuSelection>(selection);
  if (latest.current.query !== menu.query) latest.current = { query: menu.query, index: FIRST_MATCH };
  /**
   * The pointer as the last key left it, clamped to the matches on screen now. Every handler
   * reads this rather than the render's `selected`: two keys delivered in one batch both run
   * before the re-render, so a return in that batch would otherwise run the row the pointer
   * has already moved off.
   */
  const pointer = (): number => Math.min(Math.max(latest.current.index, FIRST_MATCH), matches.length - 1);

  /** Move the pointer `delta` rows from where the last key left it, never past either end. */
  const move = (delta: number): void => {
    const value: MenuSelection = {
      query: menu.query,
      index: Math.min(Math.max(pointer() + delta, FIRST_MATCH), matches.length - 1),
    };
    latest.current = value;
    setSelection(value);
  };

  useInput(
    (_input, key) => {
      if (!ownsMenuKey(key)) return;
      if (key.escape) {
        onClose();
        return;
      }
      // A shifted key is another surface's: shift+arrows scroll the viewport, shift+tab
      // cycles the mode, shift+return is a newline in the prompt.
      if (key.shift || key.ctrl || key.meta) return;
      const item = matches[pointer()];
      if (item === undefined) return;
      if (key.tab) onComplete(item.name);
      else if (key.return) onRun(item.name);
      else if (key.upArrow) move(-1);
      else if (key.downArrow) move(1);
    },
    { isActive: active },
  );

  const layout = slashMenuLayout(matches, { width, theme, selected: pointer() });
  return (
    <Box flexDirection="column">
      {layout.lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the menu's rows are positional and redrawn whole as the window moves.
        <StyledLineView key={index} line={line} theme={theme} />
      ))}
    </Box>
  );
}
