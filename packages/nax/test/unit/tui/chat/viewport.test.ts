import { describe, expect, test } from "bun:test";
import {
  INITIAL_VIEWPORT,
  reduceViewport,
  type ViewportAction,
  type ViewportState,
  visibleRange,
} from "@/tui/chat/viewport";

/** A transcript of 100 lines in a 10-row view: the offset may reach 90. */
const TOTAL = 100;
const HEIGHT = 10;

/** A state with the initial values replaced by `overrides`. */
function state(overrides: Partial<ViewportState> = {}): ViewportState {
  return { ...INITIAL_VIEWPORT, ...overrides };
}

/** The state after `action` against the 100-line, 10-row transcript. */
function apply(from: ViewportState, action: ViewportAction): ViewportState {
  return reduceViewport(from, action, TOTAL, HEIGHT);
}

describe("INITIAL_VIEWPORT", () => {
  test("starts at the bottom, following, with nothing unseen", () => {
    expect(INITIAL_VIEWPORT).toEqual({ offset: 0, follow: true, unseen: 0 });
  });
});

describe("reduceViewport — content", () => {
  test("keeps the bottom in view when content arrives while following", () => {
    // AC-1
    const next = reduceViewport(INITIAL_VIEWPORT, { type: "content", total: TOTAL, height: HEIGHT }, TOTAL, HEIGHT);
    expect(next).toEqual({ offset: 0, follow: true, unseen: 0 });
  });

  test("keeps the offset at the bottom while following as the transcript grows", () => {
    // AC-6
    const next = reduceViewport(state(), { type: "content", total: 105, height: HEIGHT }, TOTAL, HEIGHT);
    expect(next).toEqual({ offset: 0, follow: true, unseen: 0 });
  });

  test("adds the growth to the offset while scrolled up", () => {
    // AC-4
    const next = reduceViewport(
      state({ offset: 9, follow: false }),
      { type: "content", total: 105, height: HEIGHT },
      TOTAL,
      HEIGHT,
    );
    expect(next.offset).toBe(14);
  });

  test("counts the growth as unseen while scrolled up", () => {
    // AC-5
    const next = reduceViewport(
      state({ offset: 9, follow: false }),
      { type: "content", total: 105, height: HEIGHT },
      TOTAL,
      HEIGHT,
    );
    expect(next.unseen).toBe(5);
  });

  test("clamps the offset when the transcript shrinks and leaves the unseen count alone", () => {
    // AC-17
    const next = reduceViewport(
      state({ offset: 50, follow: false, unseen: 3 }),
      { type: "content", total: 20, height: HEIGHT },
      TOTAL,
      HEIGHT,
    );
    expect(next.offset).toBe(10);
    expect(next.unseen).toBe(3);
  });

  test("re-clamps the offset when the viewport grows", () => {
    // AC-18
    const next = reduceViewport(
      state({ offset: 90, follow: false }),
      { type: "content", total: 100, height: 30 },
      TOTAL,
      HEIGHT,
    );
    expect(next.offset).toBe(70);
  });

  test("returns to following when a shrink leaves nothing to scroll", () => {
    const next = reduceViewport(
      state({ offset: 5, follow: false, unseen: 2 }),
      { type: "content", total: 4, height: HEIGHT },
      TOTAL,
      HEIGHT,
    );
    expect(next).toEqual({ offset: 0, follow: true, unseen: 0 });
  });

  test("does not count a shrink as unseen lines", () => {
    const next = reduceViewport(
      state({ offset: 40, follow: false, unseen: 2 }),
      { type: "content", total: 60, height: HEIGHT },
      TOTAL,
      HEIGHT,
    );
    expect(next.unseen).toBe(2);
    expect(next.offset).toBe(40);
  });
});

describe("reduceViewport — paging and line moves", () => {
  test("pageUp moves one page up", () => {
    // AC-2
    expect(apply(state(), { type: "pageUp" }).offset).toBe(9);
  });

  test("pageUp stops following", () => {
    // AC-3
    expect(apply(state(), { type: "pageUp" }).follow).toBe(false);
  });

  test("pageDown back to the bottom resumes following and clears the unseen count", () => {
    // AC-7
    expect(apply(state({ offset: 9, follow: false, unseen: 5 }), { type: "pageDown" })).toEqual({
      offset: 0,
      follow: true,
      unseen: 0,
    });
  });

  test("lineUp moves a single line up", () => {
    // AC-8
    expect(apply(state(), { type: "lineUp" }).offset).toBe(1);
  });

  test("lineDown from one line up returns to the bottom and follows", () => {
    // AC-9
    expect(apply(state({ offset: 1, follow: false }), { type: "lineDown" })).toEqual({
      offset: 0,
      follow: true,
      unseen: 0,
    });
  });

  test("repeated pageUp stops at the top of the transcript", () => {
    // AC-10
    const top = Array.from({ length: 20 }).reduce<ViewportState>((from) => apply(from, { type: "pageUp" }), state());
    expect(top.offset).toBe(90);
  });

  test("pageUp in a transcript shorter than the view stays at the bottom", () => {
    // AC-11
    expect(reduceViewport(state(), { type: "pageUp" }, 5, HEIGHT)).toEqual({ offset: 0, follow: true, unseen: 0 });
  });

  test("home goes to the top of the transcript", () => {
    // AC-12
    expect(apply(state(), { type: "home" })).toEqual({ offset: 90, follow: false, unseen: 0 });
  });

  test("home on a short transcript stays at the bottom", () => {
    expect(reduceViewport(state(), { type: "home" }, 5, HEIGHT)).toEqual({ offset: 0, follow: true, unseen: 0 });
  });

  test.each([
    { label: "following", from: { offset: 0, follow: true, unseen: 0 } },
    { label: "scrolled up", from: { offset: 9, follow: false, unseen: 5 } },
    { label: "at the top", from: { offset: 90, follow: false, unseen: 0 } },
    { label: "one line up", from: { offset: 1, follow: false, unseen: 1 } },
  ])("end from a $label state returns the initial viewport", ({ from }) => {
    // AC-13
    expect(apply(from, { type: "end" })).toEqual(INITIAL_VIEWPORT);
  });

  test("leaves the input state untouched", () => {
    const from = state({ offset: 4, follow: false, unseen: 2 });
    apply(from, { type: "pageUp" });
    expect(from).toEqual({ offset: 4, follow: false, unseen: 2 });
  });
});

describe("visibleRange", () => {
  test.each([
    { total: 100, height: 10, offset: 0 },
    { total: 100, height: 10, offset: 9 },
    { total: 5, height: 10, offset: 0 },
  ])("shows the window of $total lines above offset $offset in a $height row view", ({ total, height, offset }) => {
    const { start, end } = visibleRange(total, height, offset);
    expect(end).toBe(total - offset);
    expect(start).toBe(Math.max(0, end - height));
  });

  test("ends at the last line when the view is at the bottom", () => {
    // AC-14
    expect(visibleRange(100, 10, 0)).toEqual({ start: 90, end: 100 });
  });

  test("shows the page above the scrolled-off lines", () => {
    // AC-15
    expect(visibleRange(100, 10, 9)).toEqual({ start: 81, end: 91 });
  });

  test("starts at the first line when the transcript is shorter than the view", () => {
    // AC-16
    expect(visibleRange(5, 10, 0)).toEqual({ start: 0, end: 5 });
  });
});
