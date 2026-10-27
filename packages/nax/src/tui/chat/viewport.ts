/**
 * The transcript viewport as data: how far the view is scrolled up from the last line,
 * whether it is following the last line, and how many lines arrived while it was not.
 *
 * `offset` counts the lines between the bottom of the view and the last line, so `0` means
 * the last line is on screen and `total - height` means the first line is. Every action is
 * folded into a new state; the reducer is pure, so the view can render any state it is
 * handed and the keys can be tested without ink.
 *
 * `reduceViewport`'s `total` and `height` are the values *before* the action — a `content`
 * action carries the new ones, because it is the one action that changes them.
 */

export interface ViewportState {
  readonly offset: number;
  readonly follow: boolean;
  readonly unseen: number;
}

export type ViewportAction =
  | { type: "content"; total: number; height: number }
  | { type: "pageUp" }
  | { type: "pageDown" }
  | { type: "lineUp" }
  | { type: "lineDown" }
  | { type: "wheelUp" }
  | { type: "wheelDown" }
  | { type: "home" }
  | { type: "end" };

/** At the bottom, following, nothing unseen — the state a viewport starts and ends in. */
export const INITIAL_VIEWPORT: ViewportState = { offset: 0, follow: true, unseen: 0 };

/** A line move moves one line; a page keeps one line of the previous page as context. */
const LINE_STEP = 1;
const WHEEL_LINES = 3;
const PAGE_OVERLAP = 1;

/** The furthest the view can scroll before the first line sits at the top of the view. */
function maxOffset(total: number, height: number): number {
  return Math.max(0, total - height);
}

function clampOffset(offset: number, total: number, height: number): number {
  return Math.min(Math.max(offset, 0), maxOffset(total, height));
}

/**
 * The state a raw offset settles into. An offset of `0` is the bottom of the transcript, so
 * the view follows again and has nothing unseen; any other offset is scrolled up, which
 * keeps the unseen count it was given.
 */
function settle(offset: number, total: number, height: number, unseen: number): ViewportState {
  const clamped = clampOffset(offset, total, height);
  return clamped === 0 ? INITIAL_VIEWPORT : { offset: clamped, follow: false, unseen };
}

/**
 * A content change: lines that arrive while following stay in view, and lines that arrive
 * while scrolled up push the view up by as much so it keeps showing the same text, counting
 * them as unseen. A shrink — `/clear`, a compaction — never adds to `unseen`.
 */
function afterContent(
  state: ViewportState,
  action: Extract<ViewportAction, { type: "content" }>,
  total: number,
): ViewportState {
  const growth = Math.max(0, action.total - total);
  const offset = state.follow ? 0 : state.offset + growth;
  const unseen = state.follow ? state.unseen : state.unseen + growth;
  return settle(offset, action.total, action.height, unseen);
}

function afterMove(state: ViewportState, delta: number, total: number, height: number): ViewportState {
  return settle(state.offset + delta, total, height, state.unseen);
}

/** Folds one viewport action into the next state. */
export function reduceViewport(
  state: ViewportState,
  action: ViewportAction,
  total: number,
  height: number,
): ViewportState {
  switch (action.type) {
    case "content":
      return afterContent(state, action, total);
    case "pageUp":
      return afterMove(state, height - PAGE_OVERLAP, total, height);
    case "pageDown":
      return afterMove(state, PAGE_OVERLAP - height, total, height);
    case "lineUp":
      return afterMove(state, LINE_STEP, total, height);
    case "lineDown":
      return afterMove(state, -LINE_STEP, total, height);
    case "wheelUp":
      return afterMove(state, WHEEL_LINES, total, height);
    case "wheelDown":
      return afterMove(state, -WHEEL_LINES, total, height);
    case "home":
      return settle(maxOffset(total, height), total, height, state.unseen);
    case "end":
      return INITIAL_VIEWPORT;
  }
}

/**
 * The half-open range `[start, end)` of transcript lines the view shows: the `height` lines
 * above the `offset` lines scrolled off the bottom, never before the first line.
 */
export function visibleRange(total: number, height: number, offset: number): { start: number; end: number } {
  const end = Math.min(total, Math.max(total - offset, 0));
  return { start: Math.max(end - height, 0), end };
}
