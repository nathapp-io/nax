/**
 * The `@` picker's rows under the chat input, and nothing else.
 *
 * The view holds no state and subscribes to no keys: which rows a query keeps, where the
 * pointer is, and whether the picker owns the keys at all is `use-mention-menu.ts`'s, because
 * a batch of keys is delivered before this component could be mounted to see them. All this
 * draws is what that hook decided — the pointer's row in the accent colour, the rest bold-free
 * and plain, each name cut to the terminal rather than wrapped into rows the screen did not
 * measure. A file list git could not produce has no rows to draw, so the picker says so in one
 * muted line instead and claims no key at all.
 *
 * Every row is one physical row: the window follows the pointer, so a repository with a
 * thousand files shows the same rows the slash menu's own window would.
 */
import { Box } from "ink";
import type { ReactElement } from "react";
import type { MentionFileRow } from "@/chat";
import { oneLine, resolveWidth, SPACE, styled } from "./layout-lines";
import { displayWidth, type Span, type StyledLine, StyledLineView, sanitizeText } from "./styled-line";
import type { ChatTheme } from "./theme";
import type { MentionMenuView } from "./use-mention-menu";
import { cutSpans } from "./wrap";

/** The line a failed listing draws in place of rows: the picker cannot offer what git could not say. */
export const NO_FILE_LIST_LINE = "no file list from git";

/** The first row, and where a window that has no pointer to follow starts. */
const FIRST_ROW = 0;

/** The pointer's own columns: the glyph and a space, or the blank that keeps names aligned. */
function pointerPrefix(theme: ChatTheme, chosen: boolean): Span {
  const pointer = theme.glyphs.pointer;
  if (!chosen) return styled(SPACE.repeat(displayWidth(pointer) + SPACE.length));
  return styled(`${pointer}${SPACE}`, { color: "accent" });
}

/**
 * The row a path draws: one line of display-safe text, the pointer on the chosen one. A path
 * comes from the repository rather than from nax, so it is flattened and stripped before it
 * becomes display text — a control byte in a file name must not reach the alternate screen.
 */
function menuRow(row: MentionFileRow, options: { chosen: boolean; width: number; theme: ChatTheme }): StyledLine {
  const name = styled(oneLine(sanitizeText(row.path)), options.chosen ? { bold: true } : {});
  return cutSpans([pointerPrefix(options.theme, options.chosen), name], options.width);
}

export interface MentionMenuLayoutOptions {
  /** The columns the picker is drawn into. */
  readonly width: number;
  readonly theme: ChatTheme;
}

/**
 * The rows the picker draws: `view.rows` of the matches, windowed so the pointer stays inside
 * the window — the rows the screen measured in `view.rows` are the rows on screen.
 */
export function mentionMenuLayout(view: MentionMenuView, options: MentionMenuLayoutOptions): readonly StyledLine[] {
  const rows = Math.max(FIRST_ROW, Math.min(view.rows, view.matches.length));
  if (rows === FIRST_ROW) return [];
  const furthest = Math.max(FIRST_ROW, view.matches.length - rows);
  const first = Math.min(Math.max(view.selected - rows + 1, FIRST_ROW), furthest);
  const width = resolveWidth(options.width);
  return view.matches
    .slice(first, first + rows)
    .map((row, at) => menuRow(row, { chosen: first + at === view.selected, width, theme: options.theme }));
}

export interface MentionMenuProps {
  /** What the picker's hook decided this render: its rows, the pointer and its height. */
  readonly view: MentionMenuView;
  readonly width: number;
  readonly theme: ChatTheme;
}

/**
 * The `@` picker, drawn between the input's closing rule and the footer — or nothing at all,
 * when the hook decided the picker has no row to show.
 */
export function MentionMenu({ view, width, theme }: MentionMenuProps): ReactElement | null {
  if (view.rows <= 0) return null;
  if (view.noGit) {
    const line = cutSpans([styled(NO_FILE_LIST_LINE, { color: "muted" })], resolveWidth(width));
    return (
      <Box flexDirection="column">
        <StyledLineView line={line} theme={theme} />
      </Box>
    );
  }
  const lines = mentionMenuLayout(view, { width, theme });
  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the picker's rows are positional and redrawn whole as the window moves.
        <StyledLineView key={index} line={line} theme={theme} />
      ))}
    </Box>
  );
}
