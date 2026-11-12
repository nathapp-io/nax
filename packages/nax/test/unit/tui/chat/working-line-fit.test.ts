import { describe, expect, test } from "bun:test";
import { GLYPHS, IDLE_STATUS, type TurnStatus, workingLine } from "@/tui/chat/chat-status";
import { fittedWorkingLine } from "@/tui/chat/status-layout";
import { plainText } from "@/tui/chat/styled-line";
import { spansWidth } from "@/tui/chat/wrap";

const STARTED_AT = "2026-11-11T00:00:00Z";
const STARTED_AT_MS = Date.parse(STARTED_AT);
const TWELVE_SECONDS = 12_000;
const FIT_WIDTH = 40;
const NARROW_WIDTH = 12;

/** A thinking turn since `STARTED_AT`; every case here varies one thing from it. */
const THINKING: TurnStatus = { ...IDLE_STATUS, running: true, phase: "thinking", startedAt: STARTED_AT };

/** The text a line draws, or "" when no row is claimed at all. */
function textOf(line: ReturnType<typeof workingLine>): string {
  return plainText(line ?? []);
}

describe("workingLine with a width", () => {
  test("AC-1 keeps the verb and the elapsed seconds inside 40 columns", () => {
    const status: TurnStatus = { ...THINKING, streamedChars: 40 };
    const line = workingLine(status, STARTED_AT_MS + TWELVE_SECONDS, GLYPHS, undefined, FIT_WIDTH);
    expect(textOf(line).endsWith("(12s)")).toBe(true);
    expect(spansWidth(line ?? [])).toBeLessThanOrEqual(FIT_WIDTH);
  });

  test("AC-2 draws the full measurement when no width is given", () => {
    const status: TurnStatus = { ...THINKING, streamedChars: 40 };
    const text = textOf(workingLine(status, STARTED_AT_MS + TWELVE_SECONDS, GLYPHS));
    expect(text).toContain("↓ ~10 tokens");
    expect(text).toContain("esc to interrupt");
  });

  test("AC-3 elides the compact row with the theme ellipsis when it is still too wide", () => {
    const line = workingLine(THINKING, STARTED_AT_MS + TWELVE_SECONDS, GLYPHS, undefined, NARROW_WIDTH);
    const text = textOf(line);
    expect(spansWidth(line ?? [])).toBeLessThanOrEqual(NARROW_WIDTH);
    expect(text.endsWith(GLYPHS.ellipsis)).toBe(true);
    expect(text.endsWith("…")).toBe(true);
  });

  test("AC-4 counts a non-finite now as no elapsed time", () => {
    const text = textOf(workingLine(THINKING, Number.NaN, GLYPHS, undefined, FIT_WIDTH));
    expect(text).toContain("(0s)");
  });

  test("AC-5 counts a start that does not parse as no elapsed time", () => {
    const status: TurnStatus = { ...THINKING, startedAt: "now" };
    const text = textOf(workingLine(status, 5000, GLYPHS, undefined, FIT_WIDTH));
    expect(text).toContain("(0s)");
  });

  test("AC-6 counts a now before the start as no elapsed time", () => {
    const status: TurnStatus = { ...THINKING, startedAt: "2026-11-11T00:00:10Z" };
    const text = textOf(workingLine(status, Date.parse("2026-11-11T00:00:00Z"), GLYPHS, undefined, FIT_WIDTH));
    expect(text).toContain("(0s)");
  });
});

describe("fittedWorkingLine", () => {
  test("AC-7 delegates the narrow row to workingLine", () => {
    const now = STARTED_AT_MS + TWELVE_SECONDS;
    const fitted = fittedWorkingLine(THINKING, now, GLYPHS, undefined, NARROW_WIDTH);
    expect(textOf(fitted)).toBe(textOf(workingLine(THINKING, now, GLYPHS, undefined, NARROW_WIDTH)));
  });
});
