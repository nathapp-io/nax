/**
 * Transcript viewport — the scrolling window over the styled transcript lines.
 *
 * All scrolling arithmetic lives in `viewport.ts`: this component owns a `ViewportState`
 * and feeds it actions, so the rules for following the last line, counting unseen lines
 * and clamping the offset are written once. A changed line count or window height arrives
 * as a prop and is fed in as the reducer's `content` action; the six keys the view owns
 * (pageUp, pageDown, shift+upArrow, shift+downArrow, home, end) each map to one action.
 *
 * The window is exactly `height` rows: the visible lines with blank rows padded at the bottom
 * while the transcript is shorter than the window. Every row is one physical row — an empty
 * line still takes its row, and anything measuring wider than the window is clipped rather
 * than wrapped — so the height the caller allocated is the height drawn. While lines are
 * unseen the bottom row becomes the muted `↓ <n> new lines (End)` marker, naming the key
 * that returns to them.
 */
import { Box, type Key, Text, useInput } from "ink";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import type { MouseEvents } from "./mouse-input";
import { highlightLine } from "./selection";
import { type StyledLine, StyledLineView } from "./styled-line";
import type { ChatTheme } from "./theme";
import { useMouseSelection } from "./use-mouse-selection";
import { INITIAL_VIEWPORT, reduceViewport, type ViewportAction, type ViewportState, visibleRange } from "./viewport";

/** The shortest window the view will draw; ChatApp guarantees at least this many rows. */
const MIN_VIEWPORT_ROWS = 1;

/** Every row of the window is one physical row, whatever its content measures. */
const ROW_HEIGHT = 1;

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
  readonly mouse?: MouseEvents;
  readonly top?: number;
  readonly onCopy?: (text: string) => void;
  readonly onClick?: (line: number) => void;
  /**
   * Bumped by the owner when the window must return to the newest line — the user sent a
   * message. The view cannot see the send itself, and a send while scrolled up would
   * otherwise leave the user's own message below the fold, behind the unseen marker.
   */
  readonly followToken?: number;
}

/** What the reducer has seen so far: the state plus the inputs the next action is relative to. */
interface ViewportMemory {
  readonly state: ViewportState;
  readonly total: number;
  readonly height: number;
  readonly token: number;
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
  return { ...memory, state, total, height };
}

/**
 * The memory the frame's props settle into. The content change is folded in first — so a line
 * count that moved in the same frame as the token is accounted for — and then a bumped token
 * returns the window to the newest line, which is the `end` action.
 */
function nextMemory(memory: ViewportMemory, total: number, height: number, token: number): ViewportMemory {
  const content = memory.total === total && memory.height === height ? memory : afterContent(memory, total, height);
  if (content.token === token) return content;
  const state = reduceViewport(content.state, { type: "end" }, content.total, content.height);
  return { ...content, state, token };
}

interface ViewportRowsProps {
  readonly visible: readonly StyledLine[];
  readonly rows: number;
  readonly unseen: number;
  readonly theme: ChatTheme;
}

/**
 * One row of the window. The fixed height plus clipped overflow keeps the window at exactly
 * `rows` physical rows: an empty line (the gap `layoutTranscript` puts between entries, and
 * a line whose spans are all empty) still takes its row instead of collapsing, and a line,
 * or the unseen marker, that measures wider than the window is clipped rather than wrapped
 * into rows the height budget never allocated.
 */
function ViewportRow({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <Box height={ROW_HEIGHT} overflow="hidden">
      {children}
    </Box>
  );
}

/** The `rows`-tall window: visible lines, blank padding, then the bottom unseen marker. */
function ViewportRows({ visible, rows, unseen, theme }: ViewportRowsProps): ReactElement {
  const showingUnseen = unseen > 0;
  const body = showingUnseen ? visible.slice(0, -1) : visible;
  const padding = Math.max(0, rows - body.length - (showingUnseen ? 1 : 0));
  return (
    <Box flexDirection="column">
      {body.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a row's identity is its position in the window, which every scroll redraws.
        <ViewportRow key={index}>
          <StyledLineView line={line} theme={theme} />
        </ViewportRow>
      ))}
      {Array.from({ length: padding }, (_unused, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blank rows are interchangeable and the window is re-rendered whole.
        <ViewportRow key={`padding-${index}`}>
          <Text>{BLANK_ROW}</Text>
        </ViewportRow>
      ))}
      {showingUnseen ? (
        <ViewportRow>
          <Text wrap="truncate" color={theme.colors.muted}>
            {`${UNSEEN_MARKER} ${unseen} ${UNSEEN_LABEL}`}
          </Text>
        </ViewportRow>
      ) : null}
    </Box>
  );
}

export function TranscriptViewport({
  lines,
  height,
  theme,
  active = true,
  mouse,
  top = 0,
  onCopy,
  onClick,
  followToken = 0,
}: TranscriptViewportProps): ReactElement {
  const rows = viewRows(height);
  const total = lines.length;
  const [memory, setMemory] = useState<ViewportMemory>({
    state: INITIAL_VIEWPORT,
    total,
    height: rows,
    token: followToken,
  });
  // Content, height and the follow token arrive as props, so a change is fed back in as the
  // actions the reducer expects rather than re-derived here. Adjusting the state during
  // render (instead of in an effect) keeps the frame that follows a change consistent with
  // it — no stale paint in between.
  if (memory.total !== total || memory.height !== rows || memory.token !== followToken) {
    setMemory(nextMemory(memory, total, rows, followToken));
  }
  useEffect(() => {
    if (!active || !mouse) return;
    return mouse.subscribe((event) => {
      if (event.kind !== "wheelUp" && event.kind !== "wheelDown") return;
      const action: ViewportAction = { type: event.kind };
      setMemory((previous) => ({
        ...previous,
        state: reduceViewport(previous.state, action, previous.total, previous.height),
      }));
    });
  }, [active, mouse]);
  useInput(
    (_input, key) => {
      const action = viewportAction(key);
      if (action === undefined) return;
      setMemory((previous) => ({
        ...previous,
        state: reduceViewport(previous.state, action, previous.total, previous.height),
      }));
    },
    { isActive: active },
  );
  const selection = useMouseSelection({
    mouse,
    active,
    lines,
    onCopy,
    onClick: (point) => onClick?.(point.line),
    geometry: { top, height: rows, total, offset: memory.state.offset, unseen: memory.state.unseen },
  });
  const { start, end } = visibleRange(total, rows, memory.state.offset);
  const visible = lines
    .slice(start, end)
    .map((line, index) => (selection ? highlightLine(line, start + index, selection) : line));
  return <ViewportRows visible={visible} rows={rows} unseen={memory.state.unseen} theme={theme} />;
}
