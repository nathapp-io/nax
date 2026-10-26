import { describe, expect, test } from "bun:test";
import { type LayoutOptions, layoutTranscript } from "@/tui/chat/layout";
import { displayWidth, plainText, type Span, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

const theme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });
const asciiTheme: ChatTheme = resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 3 });

const WIDTH = 40;
const NARROW_WIDTH = 20;
/** Below `MIN_LAYOUT_WIDTH`, so the layout must treat it as the minimum. */
const TINY_WIDTH = 4;
const MINIMUM_WIDTH = 10;

const AT = "2026-10-01T00:00:00.000Z";
const AT_PLUS_6S = "2026-10-01T00:00:06.000Z";

const THOUGHT = "weighing the ordering options";
/** One "word" wider than the columns a user line leaves for its content. */
const WIDE_TEXT = "日".repeat(30);
/** Twelve five-letter words: a reply that wraps at any narrow width. */
const PARAGRAPH = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";

type ThinkingEntry = Extract<TranscriptEntry, { kind: "thinking" }>;

function layout(entries: readonly TranscriptEntry[], options: Partial<LayoutOptions> = {}): readonly StyledLine[] {
  return layoutTranscript(entries, { width: WIDTH, theme, expanded: false, ...options });
}

function texts(lines: readonly StyledLine[]): readonly string[] {
  return lines.map(plainText);
}

/** The only line of a one-entry layout — the model tests are one-line cases. */
function onlyLine(entries: readonly TranscriptEntry[], options: Partial<LayoutOptions> = {}): StyledLine {
  const lines = layout(entries, options);
  expect(texts(lines)).toHaveLength(1);
  return lines[0];
}

/** The span whose text is exactly `text`, failing the test when there is none. */
function spanWith(line: StyledLine, text: string): Span {
  const span = line.find((candidate) => candidate.text === text);
  if (span === undefined) {
    throw new Error(`no span ${JSON.stringify(text)} in line ${JSON.stringify(plainText(line))}`);
  }
  return span;
}

function userEntry(text: string): TranscriptEntry {
  return { kind: "user", text };
}

function replyEntry(text: string): TranscriptEntry {
  return { kind: "reply", turnId: "t1", text };
}

function thinkingEntry(overrides: Partial<ThinkingEntry> = {}): ThinkingEntry {
  return { kind: "thinking", turnId: "t1", text: THOUGHT, startedAt: AT, endedAt: AT_PLUS_6S, ...overrides };
}

/** Every line's display width, for the "never wider than the layout" assertions. */
function widths(lines: readonly StyledLine[]): readonly number[] {
  return lines.map((line) => displayWidth(plainText(line)));
}

describe("layoutTranscript: user entries", () => {
  test("lays a one-line user message out as the marker and its text", () => {
    expect(texts(layout([userEntry("hi")]))).toEqual(["> hi"]);
  });

  test("colours the marker accent and bands every span", () => {
    const line = onlyLine([userEntry("hi")]);
    expect(spanWith(line, ">").color).toBe("accent");
    for (const span of line) expect(span.background).toBe("userBand");
  });

  test("prefixes the first source line with the marker and the rest with two spaces", () => {
    expect(texts(layout([userEntry("a\nb")]))).toEqual(["> a", "  b"]);
  });

  test("sanitises a message carrying an escape sequence", () => {
    expect(texts(layout([userEntry("a\u001b[31mb")]))).toEqual(["> ab"]);
  });

  test("wraps a single word wider than the line at the columns left to it", () => {
    const lines = layout([userEntry(WIDE_TEXT)], { width: NARROW_WIDTH });
    expect(lines.length).toBeGreaterThan(1);
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
  });
});

describe("layoutTranscript: reply entries", () => {
  test("draws a one-line reply behind the bullet glyph", () => {
    expect(texts(layout([replyEntry("done")]))).toEqual([`${theme.glyphs.bullet} done`]);
  });

  test("draws the bullet glyph of the theme it is given", () => {
    const line = onlyLine([replyEntry("done")], { theme: asciiTheme });
    expect(plainText(line).startsWith("* ")).toBe(true);
  });

  test("indents the second and later markdown lines by two columns", () => {
    const lines = layout([replyEntry("- one\n- two\n- three")]);
    expect(texts(lines)).toHaveLength(3);
    expect(plainText(lines[0]).startsWith(theme.glyphs.bullet)).toBe(true);
    expect(plainText(lines[1]).startsWith("  ")).toBe(true);
    expect(plainText(lines[2]).startsWith("  ")).toBe(true);
  });

  test("wraps a reply wider than the layout so no line overflows", () => {
    const lines = layout([replyEntry(PARAGRAPH)], { width: NARROW_WIDTH });
    expect(lines.length).toBeGreaterThan(1);
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
  });

  test("starts every continuation line of a wrapped reply with two spaces", () => {
    const lines = layout([replyEntry(PARAGRAPH)], { width: NARROW_WIDTH });
    for (const line of lines.slice(1)) expect(plainText(line).startsWith("  ")).toBe(true);
  });

  test("cuts a code line wider than the layout at the layout's width", () => {
    const code = "const value = someFunction(argument, anotherArgument);";
    const lines = layout([replyEntry(`\`\`\`ts\n${code}\n\`\`\``)], { width: NARROW_WIDTH });
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
  });
});

describe("layoutTranscript: thinking entries", () => {
  test("lays an open thinking entry out as no lines", () => {
    expect(layout([thinkingEntry({ endedAt: undefined })])).toHaveLength(0);
  });

  test("states the collapsed duration and how to expand it", () => {
    expect(texts(layout([thinkingEntry()]))).toEqual(["✻ Thought for 6s (ctrl+o to show)"]);
  });

  test("draws the collapsed line muted and italic, without the thinking text", () => {
    const line = onlyLine([thinkingEntry()]);
    for (const span of line) {
      expect(span.color).toBe("muted");
      expect(span.italic).toBe(true);
    }
    for (const text of texts(layout([thinkingEntry()]))) expect(text).not.toContain("weighing");
  });

  test("counts an unparseable timestamp as no duration", () => {
    const entry = thinkingEntry({ startedAt: "now", endedAt: "now" });
    expect(texts(layout([entry]))).toEqual(["✻ Thought for 0s (ctrl+o to show)"]);
  });

  test("lays an expanded thinking entry out as the hide hint and its indented text", () => {
    const lines = layout([thinkingEntry({ text: "a\nb" })], { expanded: true });
    expect(plainText(lines[0]).endsWith("(ctrl+o to hide)")).toBe(true);
    expect(texts(lines).slice(1)).toEqual(["  a", "  b"]);
  });
});

describe("layoutTranscript: spacing and width", () => {
  test("puts exactly one empty line between two entries", () => {
    expect(texts(layout([userEntry("hi"), replyEntry("done")]))).toEqual(["> hi", "", `${theme.glyphs.bullet} done`]);
  });

  test("puts no separator before an entry that follows one with no lines", () => {
    const entries = [thinkingEntry({ endedAt: undefined }), replyEntry("done")];
    expect(texts(layout(entries))).toEqual([`${theme.glyphs.bullet} done`]);
  });

  test("lays out a reply at width 4 as it does at the minimum width", () => {
    const tiny = layout([replyEntry("hello world")], { width: TINY_WIDTH });
    const minimum = layout([replyEntry("hello world")], { width: MINIMUM_WIDTH });
    expect(texts(tiny)).toEqual(texts(minimum));
  });
});
