/**
 * Transcript viewport — the scrolling window over the styled transcript lines.
 *
 * All scrolling arithmetic lives in `viewport.ts`: this component owns a `ViewportState`
 * and feeds it actions, so the rules for following the last line, counting unseen lines
 * and clamping the offset are written once. A changed line count or window height arrives
 * as a prop and is fed in as the reducer's `content` action; the six keys the view owns
 * (pageUp, pageDown, shift+upArrow, shift+downArrow, home, end) each map to one action.
 *
 * The window is exactly `height` rows: the visible lines with blank rows padded at the top
 * while the transcript is shorter than the window. While lines are unseen the bottom row
 * becomes the muted `↓ <n> new lines (End)` marker, naming the key that returns to them.
 */
import { Box, type Key, Text, useInput } from "ink";
import { type ReactElement, useState } from "react";
import { type StyledLine, StyledLineView } from "./styled-line";
import type { ChatTheme } from "./theme";
import { INITIAL_VIEWPORT, reduceViewport, type ViewportAction, type ViewportState, visibleRange } from "./viewport";

/** The shortest window the view will draw; ChatApp guarantees at least this many rows. */
const MIN_VIEWPORT_ROWS = 1;

/** A blank row still has to be a row, so it is one space rather than an empty string. */
const BLANK_ROW = " ";

/** The chat glyph set carries no arrow, and the marker's text is fixed by the design. */
const UNSEEN_MARKER = "↓";
const UNSEEN_LABEL = "new lines (End)";

export interface TranscriptViewportProps {
  readonly lines: readonly StyledLine[];
  readonly height: number;
  readonly theme: ChatTheme;
  /** False while another surface — an ask card, a picker, the slash menu — owns the keys. */
  readonly active?: boolean;
}

/** What the reducer has seen so far: the state plus the inputs the next action is relative to. */
interface ViewportMemory {
  readonly state: ViewportState;
  readonly total: number;
  readonly height: number;
}

/** The window height as a whole number of rows, never below `MIN_VIEWPORT_ROWS`. */
function viewRows(height: number): number {
  return Number.isFinite(height) ? Math.max(MIN_VIEWPORT_ROWS, Math.trunc(height)) : MIN_VIEWPORT_ROWS;
}

/**
 * One action per key the view owns. A bare arrow is not one of them: with shift it moves a
 * line, without shift it belongs to the input's history and cursor.
 */
function viewportAction(key: Key): ViewportAction | undefined {
  if (key.pageUp) return { type: "pageUp" };
  if (key.pageDown) return { type: "pageDown" };
  if (key.home) return { type: "home" };
  if (key.end) return { type: "end" };
  if (!key.shift) return undefined;
  if (key.upArrow) return { type: "lineUp" };
  if (key.downArrow) return { type: "lineDown" };
  return undefined;
}

/**
 * Fold a changed line count or window height in as the `content` action the reducer expects:
 * lines that arrived while scrolled up push the view up and count as unseen, lines that
 * arrived while following stay in view, and a shrink never adds to the unseen count.
 */
function afterContent(memory: ViewportMemory, total: number, height: number): ViewportMemory {
  const state = reduceViewport(memory.state, { type: "content", total, height }, memory.total, memory.height);
  return { state, total, height };
}

interface ViewportRowsProps {
  readonly visible: readonly StyledLine[];
  readonly rows: number;
  readonly unseen: number;
  readonly theme: ChatTheme;
}

/** The `rows`-tall window: blank padding, the visible lines, then the unseen marker. */
function ViewportRows({ visible, rows, unseen, theme }: ViewportRowsProps): ReactElement {
  const showingUnseen = unseen > 0;
  const body = showingUnseen ? visible.slice(0, -1) : visible;
  const padding = Math.max(0, rows - body.length - (showingUnseen ? 1 : 0));
  return (
    <Box flexDirection="column">
      {Array.from({ length: padding }, (_unused, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blank rows are interchangeable and the window is re-rendered whole.
        <Text key={index}>{BLANK_ROW}</Text>
      ))}
      {body.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row's identity is its position in the window, which every scroll redraws.
        <StyledLineView key={index} line={line} theme={theme} />
      ))}
      {showingUnseen ? <Text color={theme.colors.muted}>{`${UNSEEN_MARKER} ${unseen} ${UNSEEN_LABEL}`}</Text> : null}
    </Box>
  );
}

export function TranscriptViewport({ lines, height, theme, active = true }: TranscriptViewportProps): ReactElement {
  const rows = viewRows(height);
  const total = lines.length;
  const [memory, setMemory] = useState<ViewportMemory>({ state: INITIAL_VIEWPORT, total, height: rows });
  // Content and height arrive as props, so a change is fed back in as a `content` action
  // rather than re-derived here. Adjusting the state during render (instead of in an effect)
  // keeps the frame that follows a change consistent with it — no stale paint in between.
  if (memory.total !== total || memory.height !== rows) setMemory(afterContent(memory, total, rows));
  useInput(
    (_input, key) => {
      const action = viewportAction(key);
      if (action === undefined) return;
      setMemory((previous) => ({
        state: reduceViewport(previous.state, action, previous.total, previous.height),
        total: previous.total,
        height: previous.height,
      }));
    },
    { isActive: active },
  );
  const { start, end } = visibleRange(total, rows, memory.state.offset);
  return <ViewportRows visible={lines.slice(start, end)} rows={rows} unseen={memory.state.unseen} theme={theme} />;
}
