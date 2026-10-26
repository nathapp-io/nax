import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "@/tui/chat/markdown";
import { MIN_LAYOUT_WIDTH, plainText, type Span, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";

const theme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });
const WIDTH = 40;
const PARAGRAPH_WIDTH = 20;
const RULE_WIDTH = 10;

const WORDS = [
  "aaaaa",
  "bbbbb",
  "ccccc",
  "ddddd",
  "eeeee",
  "fffff",
  "ggggg",
  "hhhhh",
  "iiiii",
  "jjjjj",
  "kkkkk",
  "lllll",
] as const;

function render(source: string, width: number = WIDTH): readonly StyledLine[] {
  return renderMarkdown(source, { width, theme });
}

function texts(lines: readonly StyledLine[]): readonly string[] {
  return lines.map(plainText);
}

/** The only line `source` renders — the model tests are one-line cases. */
function onlyLine(source: string, width: number = WIDTH): StyledLine {
  const lines = render(source, width);
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

/** The first span whose text starts with `prefix` — the marker or number span of a line. */
function firstSpanStartingWith(line: StyledLine, prefix: string): Span {
  const span = line.find((candidate) => candidate.text.startsWith(prefix));
  if (span === undefined) {
    throw new Error(`no span starting ${JSON.stringify(prefix)} in line ${JSON.stringify(plainText(line))}`);
  }
  return span;
}

describe("renderMarkdown headings", () => {
  test("renders a heading as its text without the marker (AC-1)", () => {
    expect(texts(render("# Title"))).toEqual(["Title"]);
  });

  test("renders every heading span bold (AC-2)", () => {
    const line = onlyLine("# Title");
    expect(line.length).toBeGreaterThan(0);
    for (const span of line) expect(span.bold).toBe(true);
  });
});

describe("renderMarkdown inline styles", () => {
  test("renders strong text as its text without the markers (AC-3)", () => {
    expect(texts(render("a **b** c"))).toEqual(["a b c"]);
  });

  test("bolds the strong span and leaves the surrounding text plain (AC-4)", () => {
    const line = onlyLine("a **b** c");
    expect(spanWith(line, "b").bold).toBe(true);
    expect(spanWith(line, "a ").bold).not.toBe(true);
  });

  test("italicises an emphasis span (AC-5)", () => {
    expect(spanWith(onlyLine("a *b*"), "b").italic).toBe(true);
  });

  test("renders inline code as its text without the backticks (AC-6)", () => {
    expect(texts(render("use `x`"))).toEqual(["use x"]);
  });

  test("colours an inline code span accent (AC-7)", () => {
    expect(spanWith(onlyLine("use `x`"), "x").color).toBe("accent");
  });

  test("renders a link as its text followed by the muted href (AC-16)", () => {
    expect(texts(render("[nax](https://x.y)"))).toEqual(["nax (https://x.y)"]);
  });

  test("colours the href suffix muted (AC-17)", () => {
    expect(spanWith(onlyLine("[nax](https://x.y)"), " (https://x.y)").color).toBe("muted");
  });
});

describe("renderMarkdown lists", () => {
  test("renders one line per unordered item with a dash marker (AC-8)", () => {
    expect(texts(render("- one\n- two"))).toEqual(["- one", "- two"]);
  });

  test("renders ordered items with their own number and a trailing space (AC-9)", () => {
    const lines = texts(render("1. one\n2. two"));
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("1. ")).toBe(true);
    expect(lines[1].startsWith("2. ")).toBe(true);
  });

  test("colours the ordered number span accent (AC-10)", () => {
    const lines = render("1. one\n2. two");
    expect(lines).toHaveLength(2);
    let expectedNumber = 1;
    for (const line of lines) {
      const marker = firstSpanStartingWith(line, `${expectedNumber}.`);
      expect(marker.color).toBe("accent");
      expectedNumber += 1;
    }
  });

  test("indents a nested item by two columns and keeps its marker (AC-11)", () => {
    const lines = texts(render("- a\n  - b"));
    expect(lines).toHaveLength(2);
    expect(lines[1].startsWith("  - ")).toBe(true);
  });
});

describe("renderMarkdown paragraphs", () => {
  test("wraps a paragraph to the given width (AC-12)", () => {
    const lines = texts(render(WORDS.join(" "), PARAGRAPH_WIDTH));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(PARAGRAPH_WIDTH);
  });

  test("wraps without losing, reordering or repeating a word (AC-13)", () => {
    const lines = texts(render(WORDS.join(" "), PARAGRAPH_WIDTH));
    expect(lines.join(" ")).toBe(WORDS.join(" "));
  });
});

describe("renderMarkdown block elements", () => {
  test("prefixes a blockquote with the muted codeSide glyph (AC-14)", () => {
    const line = onlyLine("> quoted");
    expect(plainText(line).startsWith(`${theme.glyphs.codeSide} `)).toBe(true);
    expect(firstSpanStartingWith(line, theme.glyphs.codeSide).color).toBe("muted");
  });

  test("italicises the quoted span (AC-15)", () => {
    expect(spanWith(onlyLine("> quoted"), "quoted").italic).toBe(true);
  });

  test("draws a horizontal rule as width rule glyphs, muted (AC-18)", () => {
    const line = onlyLine("---", RULE_WIDTH);
    expect(plainText(line)).toBe(theme.glyphs.rule.repeat(RULE_WIDTH));
    expect(line.length).toBeGreaterThan(0);
    for (const span of line) expect(span.color).toBe("muted");
  });
});

describe("renderMarkdown fallbacks", () => {
  test("keeps a table as its source text", () => {
    expect(texts(render("| a | b |\n| - | - |\n| 1 | 2 |"))).toEqual(["| a | b |", "| - | - |", "| 1 | 2 |"]);
  });

  test("keeps raw HTML as its source text", () => {
    expect(texts(render("<div>hi</div>"))).toEqual(["<div>hi</div>"]);
  });

  test("carries a nested emphasis inside strong as bold and italic", () => {
    const line = onlyLine("**a *b* c**");
    expect(spanWith(line, "b").bold).toBe(true);
    expect(spanWith(line, "b").italic).toBe(true);
    expect(spanWith(line, "a ").bold).toBe(true);
  });

  test("renders the paragraph of a loose list item after its marker", () => {
    expect(texts(render("- a\n\n- b"))).toEqual(["- a", "- b"]);
  });

  test("resolves a reference link without drawing its definition", () => {
    expect(texts(render("[nax][1]\n\n[1]: https://x.y"))).toEqual(["nax (https://x.y)"]);
  });
});

describe("renderMarkdown malformed input", () => {
  test("renders unclosed emphasis without throwing (AC-19)", () => {
    expect(texts(render("**unclosed")).join("\n")).toContain("unclosed");
  });

  test("renders unclosed emphasis and a stray fence as the lexer tokenises them (AC-20)", () => {
    const source = "*emph and **strong\n\n```js\nconst a = 1";
    const rendered = texts(render(source)).join("\n");
    expect(rendered).toContain("emph and");
    expect(rendered).toContain("const a = 1");
  });
});

describe("renderMarkdown invariants", () => {
  test("treats a width below the minimum as the minimum", () => {
    const narrow = texts(render("hello world again", 1));
    expect(narrow).toEqual(texts(render("hello world again", MIN_LAYOUT_WIDTH)));
  });

  test("strips escape sequences from rendered text", () => {
    expect(texts(render("a\u001b[?1049lb"))).toEqual(["ab"]);
  });
});
