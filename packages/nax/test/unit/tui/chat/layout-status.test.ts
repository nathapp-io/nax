import { describe, expect, test } from "bun:test";
import { type LayoutOptions, layoutTranscript } from "@/tui/chat/layout";
import { displayWidth, plainText, type Span, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

const theme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });

const WIDTH = 40;
/** Wide enough that neither of the banner's own lines has to wrap. */
const WIDE = 100;
const NARROW_WIDTH = 20;

const COUNTS = "skills 42 · commands 9 · mcp 3 (2 connected) · agents 4";
const TIPS = "/feature <name> loads a spec · /resume picks a session · /help lists commands";
const PARAGRAPH = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";

type WelcomeEntry = Extract<TranscriptEntry, { kind: "welcome" }>;

function layout(entries: readonly TranscriptEntry[], options: Partial<LayoutOptions> = {}): readonly StyledLine[] {
  return layoutTranscript(entries, { width: WIDTH, theme, expanded: false, ...options });
}

function texts(lines: readonly StyledLine[]): readonly string[] {
  return lines.map(plainText);
}

/** The only line of a one-entry layout — the status cases are one-line cases. */
function onlyLine(entries: readonly TranscriptEntry[], options: Partial<LayoutOptions> = {}): StyledLine {
  const lines = layout(entries, options);
  expect(texts(lines)).toHaveLength(1);
  return lines[0];
}

/** The one line whose plain text is `text`, failing the test when there is none. */
function lineWith(lines: readonly StyledLine[], text: string): StyledLine {
  const line = lines.find((candidate) => plainText(candidate) === text);
  if (line === undefined) throw new Error(`no line ${JSON.stringify(text)} in ${JSON.stringify(texts(lines))}`);
  return line;
}

/** Every span of a status line carries the same colour — the line is one statement. */
function expectColor(line: StyledLine, color: Span["color"]): void {
  expect(line.length).toBeGreaterThan(0);
  expect(line.every((span) => span.color === color)).toBe(true);
}

function welcomeEntry(overrides: Partial<WelcomeEntry> = {}): WelcomeEntry {
  return { kind: "welcome", skills: 42, commands: 9, agents: 4, mcpServers: 3, mcpConnected: 2, ...overrides };
}

function widths(lines: readonly StyledLine[]): readonly number[] {
  return lines.map((line) => displayWidth(plainText(line)));
}

describe("layoutTranscript: notice, warning and error entries", () => {
  test("draws a notice behind the notice glyph, coloured muted", () => {
    const line = onlyLine([{ kind: "notice", text: "x" }]);
    expect(plainText(line)).toBe(`${theme.glyphs.notice} x`);
    expectColor(line, "muted");
  });

  test("draws a warning behind the warning glyph, coloured warning", () => {
    const line = onlyLine([{ kind: "warning", text: "y" }]);
    expect(plainText(line)).toBe(`${theme.glyphs.warning} y`);
    expectColor(line, "warning");
  });

  test("draws an error behind the error glyph, coloured danger", () => {
    const line = onlyLine([{ kind: "error", text: "z" }]);
    expect(plainText(line)).toBe(`${theme.glyphs.error} z`);
    expectColor(line, "danger");
  });

  test("sanitises a notice carrying an escape sequence", () => {
    expect(texts(layout([{ kind: "notice", text: "a\u001b[31mb" }]))).toEqual([`${theme.glyphs.notice} ab`]);
  });

  test("draws the glyphs of the theme it is given", () => {
    const ascii = resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 3 });
    const line = onlyLine([{ kind: "error", text: "z" }], { theme: ascii });
    expect(plainText(line)).toBe(`${ascii.glyphs.error} z`);
    expect(plainText(line)).not.toBe(`${theme.glyphs.error} z`);
  });

  test("wraps a notice wider than the layout under its glyph", () => {
    const lines = layout([{ kind: "notice", text: PARAGRAPH }], { width: NARROW_WIDTH });
    expect(lines.length).toBeGreaterThan(1);
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
    for (const line of lines.slice(1))
      expect(plainText(line).startsWith(" ".repeat(displayWidth(theme.glyphs.notice) + 1))).toBe(true);
  });

  test("keeps a status line one row when it carries a line break", () => {
    expect(texts(layout([{ kind: "warning", text: "a\nb" }]))).toEqual([`${theme.glyphs.warning} a b`]);
  });

  test("draws an interruption as the result glyph and the muted reason", () => {
    const line = onlyLine([{ kind: "interrupted" }]);
    expect(plainText(line)).toBe(`  ${theme.glyphs.result}  Interrupted by user`);
    expect(line.every((span) => span.color === "muted")).toBe(true);
  });
});

describe("layoutTranscript: welcome entry", () => {
  test("states what the session has to work with", () => {
    expect(texts(layout([welcomeEntry()], { width: WIDE }))).toContain(COUNTS);
  });

  test("colours the counts line muted", () => {
    expectColor(lineWith(layout([welcomeEntry()], { width: WIDE }), COUNTS), "muted");
  });

  test("opens with the thinking glyph and the product name, bold", () => {
    const first = layout([welcomeEntry()], { width: WIDE })[0];
    expect(plainText(first)).toBe(`${theme.glyphs.thinking} nax chat`);
    expect(first.every((span) => span.bold === true)).toBe(true);
    expect(first.every((span) => span.color === "accent")).toBe(true);
  });

  test("leaves an empty line between the banner and its counts", () => {
    const lines = layout([welcomeEntry()], { width: WIDE });
    expect(texts(lines)[1]).toBe("");
    expect(texts(lines)[2]).toBe(COUNTS);
  });

  test("closes with the tips line, muted", () => {
    const lines = layout([welcomeEntry()], { width: WIDE });
    expect(texts(lines).at(-1)).toBe(TIPS);
    expectColor(lineWith(lines, TIPS), "muted");
  });

  test("counts an empty catalog as zero of everything", () => {
    const empty = welcomeEntry({ skills: 0, commands: 0, agents: 0, mcpServers: 0, mcpConnected: 0 });
    expect(texts(layout([empty], { width: WIDE }))).toContain("skills 0 · commands 0 · mcp 0 (0 connected) · agents 0");
  });

  test("wraps the counts line inside a narrow layout", () => {
    const lines = layout([welcomeEntry()], { width: NARROW_WIDTH });
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
    expect(texts(lines).join(" ")).toContain("skills 42");
  });
});
