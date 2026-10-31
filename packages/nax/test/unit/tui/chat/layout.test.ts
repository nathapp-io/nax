import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { _layoutDeps, type LayoutOptions, layoutTranscript } from "@/tui/chat/layout";
import { displayWidth, plainText, type Span, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";
import { reduceTranscript, type TranscriptEntry } from "@/tui/chat/transcript-model";

const theme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });
const asciiTheme: ChatTheme = resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 3 });
/** The 16-colour theme: its `diffAdd` and `diffRemove` have no colour to band a line with. */
const ansiTheme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 1 });

const WIDTH = 40;
const NARROW_WIDTH = 20;
/** The columns a reply's line takes before its content: the bullet or the indent. */
const GUTTER = 2;
/** Below `MIN_LAYOUT_WIDTH`, so the layout must treat it as the minimum. */
const TINY_WIDTH = 4;
const MINIMUM_WIDTH = 10;

const AT = "2026-10-01T00:00:00.000Z";
const AT_PLUS_6S = "2026-10-01T00:00:06.000Z";

const THOUGHT = "weighing the ordering options";
/** One "word" wider than the columns a user line leaves for its content. */
const WIDE_TEXT = "日".repeat(30);
/** One grapheme cluster wider than a whole narrow line, which can only be cut inside it. */
const WIDE_CLUSTER = `${"क्".repeat(15)}क`;
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

/** A card's first line — its header — which every card draws before anything else. */
function headerOf(entries: readonly TranscriptEntry[], options: Partial<LayoutOptions> = {}): StyledLine {
  return layout(entries, options)[0];
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

test("steady AC-17 reply block gap keeps the gutter indent", () => {
  expect(texts(layout([replyEntry("# T\n\npara")]))).toEqual(["⏺ T", "  ", "  para"]);
});

function thinkingEntry(overrides: Partial<ThinkingEntry> = {}): ThinkingEntry {
  return { kind: "thinking", turnId: "t1", text: THOUGHT, startedAt: AT, endedAt: AT_PLUS_6S, ...overrides };
}

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

/** A tool call, running by default: the shape the reducer builds from a `tool_call` event. */
function toolEntry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: "tool",
    turnId: "t1",
    callId: "c1",
    name: "Read",
    input: { path: "src/a.ts" },
    startedAt: AT,
    status: "running",
    children: [],
    ...overrides,
  };
}

/** A finished call: the only status that carries a result summary and an Edit's diff. */
function okEntry(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return toolEntry({ status: "ok", ...overrides });
}

/** An ok Edit of `a\nb` to `a\nc\nd`: the shared `a`, the removed `b`, the added `c` and `d`. */
const EDIT_CALL = { path: "x.ts", old_string: "a\nb", new_string: "a\nc\nd" };
/** Five Bash result lines: a collapsed card shows the first three and counts the other two. */
const FIVE_LINES = "l1\nl2\nl3\nl4\nl5";
/** The five columns a card's later summary lines, its diff lines and its expand hint start at. */
const CARD_INDENT = "     ";

function bashEntry(): ToolEntry {
  return okEntry({ name: "Bash", input: { command: "ls" }, preview: FIVE_LINES });
}

function editEntry(): ToolEntry {
  return okEntry({ name: "Edit", input: EDIT_CALL });
}

/** A one-line text delta: how the reducer appends to a reply that is already on screen. */
function textDelta(text: string): SessionEvent {
  return { type: "text_delta", sessionId: "s1", turnId: "t1", at: AT, metadata: {}, round: 1, text };
}

/** The card's lines whose content, after the five-column indent, starts with `sign`. */
function signedLines(entry: ToolEntry, sign: "-" | "+", options: Partial<LayoutOptions> = {}): readonly StyledLine[] {
  return layout([entry], options).filter((line) => plainText(line).startsWith(`${CARD_INDENT}${sign}`));
}

/** The header's bullet span, which must be the theme's bullet glyph on its own. */
function bulletOf(line: StyledLine): Span {
  return spanWith(line, theme.glyphs.bullet);
}

/** Every line's display width, for the "never wider than the layout" assertions. */
function widths(lines: readonly StyledLine[]): readonly number[] {
  return lines.map((line) => displayWidth(plainText(line)));
}

/** The reply lines with their two-column gutter taken off, joined: what the reply still says. */
function bodiesOf(lines: readonly StyledLine[]): string {
  return lines.map((line) => plainText(line).slice(GUTTER)).join(" ");
}

/** The reply's characters with the gutter and every space removed: proof nothing was lost. */
function squashed(lines: readonly StyledLine[]): string {
  return bodiesOf(lines).replace(/\s+/g, "");
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

  /** A message as `mentionTranscriptEntries` builds it: the typed text and the paths it carried. */
  function mentionEntry(text: string, mentions: readonly string[]): TranscriptEntry {
    return { kind: "user", text, mentions };
  }

  /** Every span drawn accent on the entry's first row: the marker, and any highlighted mention. */
  function accentTexts(entry: TranscriptEntry): readonly string[] {
    return onlyLine([entry])
      .filter((span) => span.color === "accent")
      .map((span) => span.text);
  }

  test("AC-11 highlights a mentioned path in accent inside the user band", () => {
    const line = onlyLine([mentionEntry("see @a.ts now", ["a.ts"])]);
    const mention = spanWith(line, "@a.ts");
    expect(mention.color).toBe("accent");
    expect(mention.background).toBe("userBand");
  });

  test("AC-12 highlights a mention that prose follows with punctuation", () => {
    expect(spanWith(onlyLine([mentionEntry("see (@a.ts).", ["a.ts"])]), "@a.ts").color).toBe("accent");
  });

  test("AC-13 draws no accent span for a path that is only part of a longer one", () => {
    expect(accentTexts(mentionEntry("see @a.tsx", ["a.ts"]))).toEqual([">"]);
  });

  test("AC-14 draws no accent span when the message lists no mentions", () => {
    expect(accentTexts(mentionEntry("see @a.ts now", []))).toEqual([">"]);
    expect(accentTexts(userEntry("see @a.ts now"))).toEqual([">"]);
  });

  test("keeps the text of a message with mentions exactly as it was typed", () => {
    expect(texts(layout([mentionEntry("see @a.ts now", ["a.ts"])]))).toEqual(["> see @a.ts now"]);
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

  test("keeps a blank source line as a blank indented line", () => {
    expect(texts(layout([userEntry("a\n\nb")]))).toEqual(["> a", "  ", "  b"]);
  });

  test("keeps a whitespace-only source line as a blank indented line", () => {
    expect(texts(layout([userEntry("a\n   \nb")]))).toEqual(["> a", "  ", "  b"]);
  });

  test("keeps a leading blank source line", () => {
    expect(texts(layout([userEntry("\na")]))).toEqual([">", "  a"]);
  });

  test("lays a newline-only message out as one blank line", () => {
    expect(texts(layout([userEntry("\n")]))).toEqual([">"]);
  });

  test("cuts a cluster wider than the columns left to it", () => {
    const lines = layout([userEntry(WIDE_CLUSTER)], { width: MINIMUM_WIDTH });
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(MINIMUM_WIDTH);
    expect(lines.map((line) => plainText(line).slice(GUTTER)).join("")).toBe(WIDE_CLUSTER);
  });
});

describe("layoutTranscript: skill entries", () => {
  const skill = { kind: "skill", name: "s", args: "go", body: "a\nb\nc" } as const;

  test("AC-8 collapses a skill into its user row and muted hint", () => {
    const lines = layout([skill]);
    expect(texts(lines)).toEqual(["> /s go", "  ⎿  skill s · 3 lines (ctrl+o to show)"]);
    for (const span of lines[1]) expect(span.color).toBe("muted");
  });

  test("AC-9 uses the ASCII result glyph", () => {
    expect(texts(layout([skill], { theme: asciiTheme }))[1]).toBe("  |  skill s · 3 lines (ctrl+o to show)");
  });

  test("AC-10 omits empty args", () => {
    expect(texts(layout([{ ...skill, args: "" }]))[0]).toBe("> /s");
  });

  test.each([
    ["AC-11", "a\n", "1 line"],
    ["AC-12", "", "0 lines"],
    ["AC-13", "a", "1 line"],
    ["CRLF", "a\r\n", "1 line"],
    ["CR", "a\r", "1 line"],
    ["one trailing break only", "a\n\n", "2 lines"],
  ])("%s counts body lines", (_ac, body, count) => {
    expect(texts(layout([{ ...skill, body }]))[1]).toBe(`  ⎿  skill s · ${count} (ctrl+o to show)`);
  });

  test("AC-14 expands muted body lines behind the card indent", () => {
    const lines = layout([skill], { expanded: true });
    expect(texts(lines)).toEqual(["> /s go", "  ⎿  skill s · 3 lines (ctrl+o to hide)", "     a", "     b", "     c"]);
    for (const row of lines.slice(1)) for (const span of row) expect(span.color).toBe("muted");
  });

  test("AC-15 wraps a 200-character body word without losing text", () => {
    const word = "x".repeat(200);
    const lines = layout([{ ...skill, body: word }], { expanded: true });
    expect(lines.length).toBeGreaterThan(3);
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(WIDTH);
    const body = texts(lines).slice(2);
    for (const row of body) expect(row.startsWith(CARD_INDENT)).toBe(true);
    expect(body.map((row) => row.slice(CARD_INDENT.length)).join("")).toBe(word);
  });

  test("AC-16 preserves an expanded blank body line", () => {
    expect(texts(layout([{ ...skill, body: "a\n\nb" }], { expanded: true }))).toEqual([
      "> /s go",
      "  ⎿  skill s · 3 lines (ctrl+o to hide)",
      "     a",
      CARD_INDENT,
      "     b",
    ]);
  });

  test("AC-17 wraps long args like a user message before one hint", () => {
    const args = "x".repeat(100);
    const rows = texts(layout([{ ...skill, args }]));
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.slice(0, -1)).toEqual([...texts(layout([userEntry(`/s ${args}`)]))]);
    expect(rows.at(-1)).toBe("  ⎿  skill s · 3 lines (ctrl+o to show)");
    expect(rows.filter((row) => row.includes("⎿  skill"))).toHaveLength(1);
  });

  test("AC-18 leaves ordinary user entries unchanged", () => {
    expect(texts(layout([userEntry("hello")]))).toEqual(["> hello"]);
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
    // The frame above, the cut code line and the frame below: a code line is cut, never wrapped.
    expect(texts(lines)).toHaveLength(3);
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
  });

  test("keeps every word of a reply that wraps at width 10", () => {
    const lines = layout([replyEntry("alpha beta gamma")], { width: MINIMUM_WIDTH });
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(MINIMUM_WIDTH);
    expect(bodiesOf(lines)).toBe("alpha beta gamma");
  });

  test("keeps every word of a reply that wraps at width 11", () => {
    const lines = layout([replyEntry("alpha beta gamma")], { width: MINIMUM_WIDTH + 1 });
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(MINIMUM_WIDTH + 1);
    expect(bodiesOf(lines)).toBe("alpha beta gamma");
  });

  test("wraps a raw HTML fallback line instead of clipping it", () => {
    const source = '<div class="wrapper">hello there friend</div>';
    const lines = layout([replyEntry(source)], { width: NARROW_WIDTH });
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
    expect(squashed(lines)).toBe(source.replace(/\s+/g, ""));
  });

  test("wraps a table's source line instead of clipping it", () => {
    const header = "| alpha | bravo | charlie | delta |";
    const source = `${header}\n| --- | --- | --- | --- |`;
    const lines = layout([replyEntry(source)], { width: NARROW_WIDTH });
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
    expect(squashed(lines)).toBe(source.replace(/\s+/g, ""));
  });

  test("wraps quoted fallback content instead of cutting it", () => {
    const html = '<div class="wrapper">hello there friend</div>';
    const lines = layout([replyEntry(`> ${html}`)], { width: MINIMUM_WIDTH });
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(MINIMUM_WIDTH);
    // The quote glyph is the reply's own decoration; every character of the HTML survives.
    const text = squashed(lines).split(theme.glyphs.codeSide).join("");
    expect(text).toBe(html.replace(/\s+/g, ""));
  });

  test("keeps a code line nested in a list to one line", () => {
    const shortCode = "const x = 1;";
    const longCode = "const value = someFunction(argument, anotherArgument);";
    const list = (code: string): string => `- run:\n\n  \`\`\`ts\n  ${code}\n  \`\`\``;
    const short = texts(layout([replyEntry(list(shortCode))], { width: NARROW_WIDTH }));
    const long = texts(layout([replyEntry(list(longCode))], { width: NARROW_WIDTH }));
    // A code line is cut, never wrapped: the long one takes no more lines than the short one.
    expect(long).toHaveLength(short.length);
    for (const width of widths(layout([replyEntry(list(longCode))], { width: NARROW_WIDTH }))) {
      expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
    }
  });

  test("keeps a code line nested in a blockquote to one line", () => {
    const shortCode = "const x = 1;";
    const longCode = "const value = someFunction(argument, anotherArgument);";
    const quote = (code: string): string => `> \`\`\`ts\n> ${code}\n> \`\`\``;
    const short = texts(layout([replyEntry(quote(shortCode))], { width: NARROW_WIDTH }));
    const long = texts(layout([replyEntry(quote(longCode))], { width: NARROW_WIDTH }));
    expect(long).toHaveLength(short.length);
    for (const width of widths(layout([replyEntry(quote(longCode))], { width: NARROW_WIDTH }))) {
      expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
    }
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

  test("keeps a blank line of an expanded thinking text", () => {
    const lines = layout([thinkingEntry({ text: "a\n\nb" })], { expanded: true });
    expect(texts(lines).slice(1)).toEqual(["  a", "  ", "  b"]);
  });

  test("keeps a newline-only expanded thinking text as a blank body line", () => {
    const lines = layout([thinkingEntry({ text: "\n" })], { expanded: true });
    expect(texts(lines)).toEqual(["✻ Thought for 6s (ctrl+o to hide)", "  "]);
  });

  test("cuts a cluster wider than the columns left to it in an expanded thinking text", () => {
    const entry = thinkingEntry({ text: WIDE_CLUSTER });
    const width = MINIMUM_WIDTH;
    const lines = layout([entry], { expanded: true, width });
    for (const value of widths(lines)) expect(value).toBeLessThanOrEqual(width);
    // The same entry with no thought is just its header, so the rest is the thought.
    const headerLines = layout([thinkingEntry({ text: "" })], { expanded: true, width }).length;
    expect(
      lines
        .slice(headerLines)
        .map((line) => plainText(line).slice(GUTTER))
        .join(""),
    ).toBe(WIDE_CLUSTER);
  });
});

describe("layoutTranscript: tool cards", () => {
  test("draws an ok Read as the bullet, the title and the argument", () => {
    expect(plainText(headerOf([okEntry()]))).toBe(`${theme.glyphs.bullet} Read(src/a.ts)`);
  });

  test("colours the bullet of an ok call success", () => {
    expect(bulletOf(headerOf([okEntry()])).color).toBe("success");
  });

  test("colours the bullet of a failed call danger", () => {
    expect(bulletOf(headerOf([okEntry({ status: "error", preview: "boom" })])).color).toBe("danger");
  });

  test("colours the bullet of a call in flight muted", () => {
    expect(bulletOf(headerOf([toolEntry()])).color).toBe("muted");
  });

  test("draws the title alone when the call carries no argument", () => {
    const line = headerOf([okEntry({ name: "acme__get", input: {} })]);
    expect(plainText(line)).toBe(`${theme.glyphs.bullet} acme__get`);
    expect(plainText(line)).not.toContain("(");
  });

  test("bolds the argument", () => {
    expect(spanWith(headerOf([okEntry()]), "(src/a.ts)").bold).toBe(true);
  });

  test("wraps a header wider than the layout, indenting the continuation two columns", () => {
    const entry = okEntry({ input: { path: `src/${"x".repeat(66)}` } });
    const lines = layout([entry], { width: NARROW_WIDTH });
    expect(lines.length).toBeGreaterThan(2);
    for (const width of widths(lines)) expect(width).toBeLessThanOrEqual(NARROW_WIDTH);
    for (const line of lines.slice(1, 2)) expect(plainText(line).startsWith(" ".repeat(GUTTER))).toBe(true);
  });

  test("keeps a reply's bullet line unchanged beside a tool card", () => {
    expect(texts(layout([okEntry({ preview: "a\nb" }), replyEntry("done")]))).toEqual([
      `${theme.glyphs.bullet} Read(src/a.ts)`,
      `  ${theme.glyphs.result}  Read 2 lines`,
      "",
      `${theme.glyphs.bullet} done`,
    ]);
  });
});

describe("layoutTranscript: tool card summary", () => {
  test("prefixes the first summary line with the result glyph", () => {
    expect(texts(layout([okEntry({ preview: "a\nb" })])).at(1)).toBe(`  ${theme.glyphs.result}  Read 2 lines`);
  });

  test("indents a card's second and later summary lines by five columns", () => {
    expect(texts(layout([bashEntry()])).slice(2, 4)).toEqual([`${CARD_INDENT}l2`, `${CARD_INDENT}l3`]);
  });

  test("sanitises a tool result before it becomes span text", () => {
    const entry = okEntry({ name: "Bash", input: { command: "ls" }, preview: "a\u001b[?1049lb" });
    const summary = texts(layout([entry]))[1];
    expect(summary).toContain("ab");
    expect(summary).not.toContain("\u001b");
  });

  test("closes a collapsed card with the expand hint", () => {
    const hint = layout([bashEntry()]).at(-1) ?? [];
    expect(plainText(hint)).toBe(`${CARD_INDENT}${theme.glyphs.ellipsis} +2 lines (ctrl+o to expand)`);
    for (const span of hint) expect(span.color).toBe("muted");
  });

  test("drops the expand hint when nothing is withheld", () => {
    const lines = texts(layout([bashEntry()], { expanded: true }));
    expect(lines.at(-1)).toBe(`${CARD_INDENT}l5`);
  });

  test("gives a summary carrying a line break one indented row per line", () => {
    const entry = okEntry({ name: "Write", input: { path: "a\nb.ts", content: "1\n2" } });
    expect(texts(layout([entry]))).toEqual([
      `${theme.glyphs.bullet} Write(a b.ts)`,
      `  ${theme.glyphs.result}  Wrote 2 lines to a`,
      `${CARD_INDENT}b.ts`,
    ]);
  });
});

describe("layoutTranscript: tool card diff", () => {
  test("bands a removed line with diffRemove", () => {
    const removed = signedLines(editEntry(), "-");
    expect(removed).toHaveLength(1);
    for (const line of removed) for (const span of line) expect(span.background).toBe("diffRemove");
  });

  test("bands an added line with diffAdd", () => {
    const added = signedLines(editEntry(), "+");
    expect(added).toHaveLength(2);
    for (const line of added) for (const span of line) expect(span.background).toBe("diffAdd");
  });

  test("colours a diff line instead when the theme has no diff background", () => {
    const removed = signedLines(editEntry(), "-", { theme: ansiTheme });
    const added = signedLines(editEntry(), "+", { theme: ansiTheme });
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(2);
    for (const line of removed) for (const span of line) expect(span.color).toBe("danger");
    for (const line of added) for (const span of line) expect(span.color).toBe("success");
  });
});

describe("layoutTranscript: per-entry cache", () => {
  const original = _layoutDeps.layoutEntry;
  let recomputed: TranscriptEntry[];

  beforeEach(() => {
    recomputed = [];
    _layoutDeps.layoutEntry = (entry, context) => {
      recomputed.push(entry);
      return original(entry, context);
    };
  });

  afterEach(() => {
    _layoutDeps.layoutEntry = original;
  });

  /** Two entries the reducer would leave untouched. */
  function pair(): readonly TranscriptEntry[] {
    return [userEntry("hi"), replyEntry("done")];
  }

  test("computes each entry once when the same entries are laid out twice", () => {
    const entries = pair();
    layout(entries);
    layout(entries);
    expect(recomputed).toHaveLength(entries.length);
  });

  test("recomputes every entry when the width changes", () => {
    const entries = pair();
    layout(entries);
    recomputed = [];
    layout(entries, { width: NARROW_WIDTH });
    expect(recomputed).toEqual([...entries]);
  });

  test("recomputes every entry when only the expansion changes", () => {
    const entries = pair();
    layout(entries);
    recomputed = [];
    layout(entries, { expanded: true });
    expect(recomputed).toEqual([...entries]);
  });

  test("keeps the lines of an entry a text delta did not touch", () => {
    const entries: readonly TranscriptEntry[] = [userEntry("hi"), replyEntry("a")];
    layout(entries);
    recomputed = [];
    const grown = reduceTranscript(entries, textDelta("b"));
    layout(grown);
    expect(recomputed).toHaveLength(1);
    expect(recomputed[0]).toBe(grown[1]);
  });

  test("caches a listing entry the layout is given", () => {
    const listing: TranscriptEntry = { kind: "listing", title: "MCP servers", text: "a" };
    layout([listing]);
    layout([listing]);
    expect(recomputed).toHaveLength(1);
  });

  test("reuses a width it has already laid the entries out at", () => {
    const entries = pair();
    layout(entries, { width: NARROW_WIDTH });
    layout(entries);
    recomputed = [];
    layout(entries, { width: NARROW_WIDTH });
    expect(recomputed).toHaveLength(0);
  });

  test("recomputes when a different theme is handed to the same entries", () => {
    const entries = pair();
    layout(entries);
    recomputed = [];
    layout(entries, { theme: asciiTheme });
    expect(recomputed).toEqual([...entries]);
  });

  test("reuses a width it laid an entry out at before other widths intervened", () => {
    const [entry] = pair();
    for (const width of [20, 21, 22, 23, 24]) layout([entry], { width });
    recomputed = [];
    layout([entry], { width: 20 });
    expect(recomputed).toHaveLength(0);
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

describe("layoutTranscript: status and listing entries beside a message", () => {
  /** One entry of every kind US-011 added, so a message is laid out among them all. */
  function statusRun(): readonly TranscriptEntry[] {
    return [
      { kind: "welcome", skills: 1, commands: 2, agents: 3, mcpServers: 4, mcpConnected: 5 },
      { kind: "notice", text: "n" },
      { kind: "warning", text: "w" },
      { kind: "error", text: "e" },
      { kind: "listing", title: "L", text: "a\nb" },
      { kind: "interrupted" },
    ];
  }

  test("keeps a user message laid out as the marker and its text", () => {
    const lines = layout([...statusRun(), userEntry("hi")]);
    expect(texts(lines).at(-1)).toBe("> hi");
  });

  test("draws every status entry it is given a line for", () => {
    const drawn = texts(layout(statusRun()));
    expect(drawn).toContain(`${theme.glyphs.notice} n`);
    expect(drawn).toContain(`${theme.glyphs.warning} w`);
    expect(drawn).toContain(`${theme.glyphs.error} e`);
    expect(drawn).toContain(`  ${theme.glyphs.result}  Interrupted by user`);
  });
});
