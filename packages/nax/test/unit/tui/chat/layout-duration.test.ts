/**
 * US-002: the `Thought for` row states a long thinking block's duration through the shared
 * chat formatter, so a minute or more reads as `<m>m <ss>s` rather than as raw seconds.
 * `layout.test.ts` keeps the sub-minute cases; this file holds the duration cases that grow
 * the row past a minute.
 */
import { describe, expect, test } from "bun:test";
import { layoutTranscript } from "@/tui/chat/layout";
import { plainText } from "@/tui/chat/styled-line";
import { resolveChatTheme } from "@/tui/chat/theme";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

const theme = resolveChatTheme({ env: {}, colorLevel: 3 });
const WIDTH = 40;

const AT = "2026-10-01T00:00:00.000Z";
const AT_PLUS_75S = "2026-10-01T00:01:15.000Z";

type ThinkingEntry = Extract<TranscriptEntry, { kind: "thinking" }>;

/** A finished thinking block: 75 seconds of thought, which the row states as `1m 15s`. */
function thinkingEntry(overrides: Partial<ThinkingEntry> = {}): ThinkingEntry {
  return {
    kind: "thinking",
    turnId: "t1",
    text: "weighing the ordering options",
    startedAt: AT,
    endedAt: AT_PLUS_75S,
    ...overrides,
  };
}

describe("layoutTranscript: a long thinking duration", () => {
  test("US-002 AC-15 states 75 seconds of thought as minutes and seconds", () => {
    const lines = layoutTranscript([thinkingEntry()], { width: WIDTH, theme, expanded: false });
    expect(lines.length).toBeGreaterThan(0);
    expect(plainText(lines[0])).toContain("Thought for 1m 15s");
  });
});
