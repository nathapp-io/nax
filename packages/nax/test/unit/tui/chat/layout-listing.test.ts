import { describe, expect, test } from "bun:test";
import { type LayoutOptions, layoutTranscript, listingTone } from "@/tui/chat/layout";
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
