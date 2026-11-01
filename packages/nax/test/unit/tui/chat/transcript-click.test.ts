import { describe, expect, test } from "bun:test";
import type { LayoutOptions } from "@/tui/chat/layout";
import { resolveChatTheme } from "@/tui/chat/theme";
import { toggleTranscriptLine } from "@/tui/chat/transcript-click";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

const theme = resolveChatTheme({ env: {}, colorLevel: 0 });
const OPTIONS: LayoutOptions = { width: 120, theme, expanded: false };

type BackgroundEntry = Extract<TranscriptEntry, { kind: "background" }>;

/** A two-line background task notice, collapsed unless a case opens it. */
const NOTICE = "[nax-tasks] background command bash-11111111 (bun dev) ended: succeeded\nRead its output.";

function background(overrides: Partial<BackgroundEntry> = {}): BackgroundEntry {
  return { kind: "background", summary: "1 background command ended · 1 succeeded", text: NOTICE, ...overrides };
}

describe("toggleTranscriptLine: background rows", () => {
  test("AC-6 clicking a collapsed notice's summary row opens that entry", () => {
    const entry = background();
    expect(toggleTranscriptLine([entry], 0, OPTIONS)).toEqual([background({ open: true })]);
  });

  test("AC-6 clicking a notice line of an open entry changes nothing", () => {
    const entries: readonly TranscriptEntry[] = [background({ open: true })];
    // Row 0 is the summary; row 1 is the notice's own first line.
    expect(toggleTranscriptLine(entries, 1, OPTIONS)).toBe(entries);
  });

  test("clicking an open entry's summary row closes it again", () => {
    expect(toggleTranscriptLine([background({ open: true })], 0, OPTIONS)).toEqual([background({ open: false })]);
  });

  test("shares every other entry with the input array, so only the clicked one is redrawn", () => {
    const user: TranscriptEntry = { kind: "user", text: "hi" };
    const notice = background();
    const toggled = toggleTranscriptLine([user, notice], 2, OPTIONS);
    expect(toggled[0]).toBe(user);
    expect(toggled[1]).toEqual(background({ open: true }));
  });
});
