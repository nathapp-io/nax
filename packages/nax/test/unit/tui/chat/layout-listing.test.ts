import { describe, expect, test } from "bun:test";
import { type LayoutOptions, layoutTranscript, listingTone } from "@/tui/chat/layout";
import { type LayoutContext, resolveWidth } from "@/tui/chat/layout-lines";
import { listingLines } from "@/tui/chat/layout-listing";
import { displayWidth, plainText, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

const theme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });

const WIDTH = 40;
const NARROW_WIDTH = 20;
const TITLE = "MCP servers";
/** The line `/mcp` writes for a server that is up, and the tone it must take. */
const CONNECTED_ROW = "x  connected, 3 tools";

function layout(entries: readonly TranscriptEntry[], options: Partial<LayoutOptions> = {}): readonly StyledLine[] {
  return layoutTranscript(entries, { width: WIDTH, theme, expanded: false, ...options });
}

function texts(lines: readonly StyledLine[]): readonly string[] {
  return lines.map(plainText);
}

function listing(text: string, title = TITLE): TranscriptEntry {
  return { kind: "listing", title, text };
}

type ListingEntry = Extract<TranscriptEntry, { kind: "listing" }>;

/** The jobs picker's output listing: a title naming the task, and its output as the text. */
const BASH_TITLE = "bash-1 · succeeded";

/** A collapsible listing; a case opens it or overrides the title. */
function collapsible(text: string, overrides: Partial<ListingEntry> = {}): ListingEntry {
  return { kind: "listing", title: BASH_TITLE, text, collapsible: true, ...overrides };
}

/** Where a card's rows start: the gutter, the result glyph and the two columns after it. */
const PREFIX = `  ${theme.glyphs.result}  `;

/** The rendering context `listingLines` takes, at the width every case lays out at. */
function context(expanded: boolean): LayoutContext {
  return { width: resolveWidth(WIDTH), theme, expanded };
}

/** The line whose plain text is `text`, failing the test when there is none. */
function lineWith(lines: readonly StyledLine[], text: string): StyledLine {
  const line = lines.find((candidate) => plainText(candidate) === text);
  if (line === undefined) throw new Error(`no line ${JSON.stringify(text)} in ${JSON.stringify(texts(lines))}`);
  return line;
}

function widths(lines: readonly StyledLine[]): readonly number[] {
  return lines.map((line) => displayWidth(plainText(line)));
}

describe("listingTone", () => {
  test.each([
    ["a  not locked (run nax mcp lock)", "warning"],
    ["b  not connected", "warning"],
    ["c  failed: x", "danger"],
    ["d  connected, 3 tools", "success"],
    ["e", "plain"],
  ] as const)("reports %s as %s", (line, tone) => {
    expect(listingTone(line)).toBe(tone);
  });

  test("reports a line that says both as the warning", () => {
    expect(listingTone("b  not connected  failed: boom")).toBe("warning");
  });

  test("treats a line mentioning none of the states as plain", () => {
    expect(listingTone("(no MCP servers)")).toBe("plain");
  });
});

describe("layoutTranscript: listing entries", () => {
  test("opens with the title, bold", () => {
    const first = layout([listing("a")])[0];
    expect(plainText(first)).toBe(TITLE);
    expect(first.every((span) => span.bold === true)).toBe(true);
  });

  test("follows the title with every text line in order", () => {
    expect(texts(layout([listing("a\nb\nc")]))).toEqual([TITLE, "a", "b", "c"]);
  });

  test("colours a connected line success", () => {
    const lines = layout([listing(CONNECTED_ROW)]);
    expect(texts(lines)).toEqual([TITLE, CONNECTED_ROW]);
    expect(lines[1].every((span) => span.color === "success")).toBe(true);
  });

  test("colours a failed line danger", () => {
    const line = lineWith(layout([listing("c  failed: x")]), "c  failed: x");
    expect(line.every((span) => span.color === "danger")).toBe(true);
  });

  test("leaves a line that reports no state uncoloured", () => {
    const line = lineWith(layout([listing("e")]), "e");
    expect(line.every((span) => span.color === undefined)).toBe(true);
  });

  test("draws only the title when the listing has no text", () => {
    expect(texts(layout([listing("")]))).toEqual([TITLE]);
  });

  test("sanitises the title and the text before they become span text", () => {
    expect(texts(layout([listing("a\u001b[31mb", "T\u001b[1mitle")]))).toEqual(["Title", "ab"]);
  });

  test("wraps a listing line wider than the layout so no line overflows", () => {
    const long = "acme  plugin workspace-tools  stdio  connected, 12 tools";
    const lines = layout([listing(long)], { width: NARROW_WIDTH });
    expect(lines.length).toBeGreaterThan(2);
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
  });

  test("keeps a blank line of the listing text", () => {
    expect(texts(layout([listing("a\n\nb")]))).toEqual([TITLE, "a", "", "b"]);
  });

  test("follows a message entry with a blank line, not a doubled one", () => {
    const lines = layout([{ kind: "user", text: "hi" }, listing("a")]);
    expect(texts(lines)).toEqual(["> hi", "", TITLE, "a"]);
  });
});

describe("listingLines: collapsible listings", () => {
  test("AC-1 collapsed, draws the bold title and one muted row counting the lines it withholds", () => {
    const lines = listingLines(collapsible("a\nb\nc"), context(false));
    expect(texts(lines)).toEqual([BASH_TITLE, `${PREFIX}3 lines (ctrl+o to show)`]);
    expect(lines[0].every((span) => span.bold === true)).toBe(true);
    for (const span of lines[1]) expect(span.color).toBe("muted");
  });

  test("AC-1 draws none of the text lines while collapsed", () => {
    const lines = texts(listingLines(collapsible("a\nb\nc"), context(false)));
    expect(lines).not.toContain("a");
  });

  test("AC-2 expanded, draws the title, the way back, then every text line", () => {
    expect(texts(listingLines(collapsible("a\nb\nc"), context(true)))).toEqual([
      BASH_TITLE,
      `${PREFIX}3 lines (ctrl+o to hide)`,
      "a",
      "b",
      "c",
    ]);
  });

  test("AC-2 counts the row itself in a muted tone", () => {
    const lines = listingLines(collapsible("a\nb\nc"), context(true));
    for (const span of lines[1]) expect(span.color).toBe("muted");
  });

  test("AC-3 counts one source line in the singular", () => {
    expect(texts(listingLines(collapsible("a"), context(false)))).toEqual([
      BASH_TITLE,
      `${PREFIX}1 line (ctrl+o to show)`,
    ]);
  });

  test("AC-4 a listing without collapsible keeps every text line while the transcript is collapsed", () => {
    expect(texts(layout([listing("a\nb\nc")], { expanded: false }))).toEqual([TITLE, "a", "b", "c"]);
  });

  test("AC-4 a listing without collapsible gains no count row when the transcript is expanded", () => {
    expect(texts(layout([listing("a\nb\nc")], { expanded: true }))).toEqual([TITLE, "a", "b", "c"]);
  });

  test("keeps a tone colour on an open listing's text lines", () => {
    const line = lineWith(listingLines(collapsible(CONNECTED_ROW), context(true)), CONNECTED_ROW);
    expect(line.every((span) => span.color === "success")).toBe(true);
  });

  test("wraps a count row wider than the layout so no row overflows it", () => {
    const lines = listingLines(collapsible("a\nb\nc"), { ...context(false), width: resolveWidth(NARROW_WIDTH) });
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
  });
});

describe("layoutTranscript: collapsible listings", () => {
  test("AC-6 the entry's own open draws every text line while the transcript is collapsed", () => {
    expect(texts(layout([collapsible("a\nb\nc", { open: true })], { expanded: false }))).toEqual([
      BASH_TITLE,
      `${PREFIX}3 lines (ctrl+o to hide)`,
      "a",
      "b",
      "c",
    ]);
  });

  test("AC-6 the entry's own closed flag hides them again while the transcript is expanded", () => {
    expect(texts(layout([collapsible("a\nb\nc", { open: false })], { expanded: true }))).toEqual([
      BASH_TITLE,
      `${PREFIX}3 lines (ctrl+o to show)`,
    ]);
  });

  test("a collapsible listing laid out collapsed draws the count row and no output", () => {
    expect(texts(layout([collapsible("a\nb\nc")], { expanded: false }))).toEqual([
      BASH_TITLE,
      `${PREFIX}3 lines (ctrl+o to show)`,
    ]);
  });
});
