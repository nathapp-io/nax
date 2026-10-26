import { afterEach, describe, expect, test } from "bun:test";
import { _markdownDeps, renderMarkdown } from "@/tui/chat/markdown";
import { displayWidth, MIN_LAYOUT_WIDTH, plainText, type Span, type StyledLine } from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";

const theme: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 3 });
const WIDTH = 40;
const PARAGRAPH_WIDTH = 20;
const RULE_WIDTH = 10;
const NARROW_WIDTH = 10;

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

const FENCE = "```";

/** One fenced block around `code`, with `language` written after the opening fence. */
function fence(code: string, language: string = "ts"): string {
  return `${FENCE}${language}\n${code}\n${FENCE}`;
}

/** The lines of a one-line fenced block: the top frame, the code line, the bottom frame. */
function fencedLines(code: string, language: string = "ts"): readonly StyledLine[] {
  return render(fence(code, language));
}

/** The one code line of a one-line fenced block, framed above and below. */
function codeLineOf(code: string, language: string = "ts"): StyledLine {
  const lines = fencedLines(code, language);
  expect(lines).toHaveLength(3);
  return lines[1];
}

/** Everything on a code line after its muted side glyph, checking that prefix is where it belongs. */
function codeSpansOf(line: StyledLine): readonly Span[] {
  expect(line.length).toBeGreaterThan(0);
  expect(line[0].color).toBe("muted");
  expect(line[0].text).toBe(`${theme.glyphs.codeSide} `);
  return line.slice(1);
}

function spansText(spans: readonly Span[]): string {
  return spans.map((span) => span.text).join("");
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

  test("draws a quoted block inside an item with the marker on its first line only (F2)", () => {
    const lines = texts(render("- > one two three four five", NARROW_WIDTH));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].startsWith("- ")).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith("  ")).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith("  -")).toBe(false);
  });

  test("draws a wrapped heading inside an item with the marker on its first line only (F2)", () => {
    const lines = texts(render("- # alpha beta gamma delta", NARROW_WIDTH));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].startsWith("- alpha")).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith("  ")).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith("  -")).toBe(false);
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

  test("wraps between graphemes so a skin-toned emoji is never split (F1)", () => {
    expect(texts(render("👍🏽👍🏽👍🏽", NARROW_WIDTH))).toEqual(["👍🏽👍🏽👍🏽"]);
  });

  test("measures a zero-width-joiner sequence as one grapheme (F1)", () => {
    expect(texts(render("👨‍👩‍👧‍👦 ok", NARROW_WIDTH))).toEqual(["👨‍👩‍👧‍👦 ok"]);
  });

  test("keeps a whole emoji on the line it wraps onto (F1)", () => {
    const lines = texts(render("aaaa 👍🏽👍🏽 bbbb", NARROW_WIDTH));
    expect(lines).toEqual(["aaaa 👍🏽👍🏽", "bbbb"]);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(NARROW_WIDTH);
  });

  test("keeps a grapheme whole when a style boundary splits it across spans (F1)", () => {
    const lines = render("aaaaaaaa`👍`🏽", NARROW_WIDTH);
    expect(texts(lines)).toEqual(["aaaaaaaa👍🏽"]);
    expect(displayWidth(plainText(lines[0]))).toBe(NARROW_WIDTH);
  });

  test("keeps each style fragment of a cross-span grapheme (F1)", () => {
    const line = onlyLine("aaaaaaaa`👍`🏽", NARROW_WIDTH);
    expect(spanWith(line, "👍").color).toBe("accent");
    expect(spanWith(line, "🏽").color).toBeUndefined();
  });
});

describe("renderMarkdown prefix budget", () => {
  test("keeps a long ordered marker and wide text within the width (F3)", () => {
    const lines = texts(render("999999999. 日本語", NARROW_WIDTH));
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(NARROW_WIDTH);
    expect(lines[0]).toContain("999.");
    expect(lines.join("")).toContain("日本");
  });

  test("keeps a deeply nested list within the width (F3)", () => {
    const lines = texts(render("- a\n  - b\n    - c\n      - d\n        - e", NARROW_WIDTH));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(NARROW_WIDTH);
  });

  test("keeps a deeply quoted block within the width (F3)", () => {
    const lines = texts(render("> > > > > deep quoted text", NARROW_WIDTH));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(NARROW_WIDTH);
  });

  test("cuts a cluster wider than the content budget so no line overflows (F3)", () => {
    const source = `${"क्".repeat(12)}क`;
    const lines = texts(render(source, NARROW_WIDTH));
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(NARROW_WIDTH);
    expect(lines.join("")).toBe(source);
  });

  test("keeps such a cluster within the width after a long ordered marker (F3)", () => {
    const lines = texts(render(`999999999. ${"क्".repeat(12)}क`, NARROW_WIDTH));
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(NARROW_WIDTH);
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

describe("renderMarkdown fenced code", () => {
  test("renders a fenced block as a top frame, one code line and a bottom frame (AC-1)", () => {
    expect(texts(fencedLines("const x = 1;"))).toHaveLength(3);
  });

  test("draws the language on the muted top frame line (AC-2)", () => {
    const top = fencedLines("const x = 1;")[0];
    expect(plainText(top)).toContain(theme.glyphs.codeTop);
    expect(plainText(top)).toContain("ts");
    expect(top.length).toBeGreaterThan(0);
    for (const span of top) expect(span.color).toBe("muted");
  });

  test("prefixes the code with the side glyph and a space (AC-3)", () => {
    expect(plainText(fencedLines("const x = 1;")[1])).toBe(`${theme.glyphs.codeSide} const x = 1;`);
  });

  test("closes the block with a muted bottom frame line (AC-4)", () => {
    const bottom = fencedLines("const x = 1;")[2];
    expect(plainText(bottom)).toContain(theme.glyphs.codeBottom);
    expect(bottom.length).toBeGreaterThan(0);
    for (const span of bottom) expect(span.color).toBe("muted");
  });

  test("colours a keyword span syntaxKeyword (AC-5)", () => {
    expect(spanWith(codeLineOf("const x = 1;"), "const").color).toBe("syntaxKeyword");
  });

  test("colours a number span syntaxNumber (AC-6)", () => {
    expect(spanWith(codeLineOf("const x = 1;"), "1").color).toBe("syntaxNumber");
  });

  test("colours a string span syntaxString (AC-7)", () => {
    expect(spanWith(codeLineOf('const s = "q";'), '"q"').color).toBe("syntaxString");
  });

  test("colours a comment span syntaxComment (AC-8)", () => {
    expect(spanWith(codeLineOf("// note"), "// note").color).toBe("syntaxComment");
  });

  test("colours a function title span syntaxTitle (AC-9)", () => {
    expect(spanWith(codeLineOf("function run() {}"), "run").color).toBe("syntaxTitle");
  });

  test("draws a fence with an unknown language as plain code (AC-10)", () => {
    const spans = codeSpansOf(codeLineOf("const x = 1;", "nosuchlang"));
    expect(spansText(spans)).toBe("const x = 1;");
    for (const span of spans) expect(span.color).toBeUndefined();
  });

  test("draws a fence with no language as plain code (AC-11)", () => {
    const spans = codeSpansOf(codeLineOf("const x = 1;", ""));
    expect(spansText(spans)).toBe("const x = 1;");
    for (const span of spans) expect(span.color).toBeUndefined();
  });

  test("does not wrap a code line longer than the width (AC-12)", () => {
    const body = "a".repeat(80);
    const lines = render(fence(body), WIDTH);
    expect(lines).toHaveLength(3);
    expect(plainText(lines[1])).toBe(`${theme.glyphs.codeSide} ${body}`);
  });

  test("renders an unclosed fence as code to the end of the text (AC-13)", () => {
    const lines = render(`${FENCE}ts\nconst a`);
    expect(lines).toHaveLength(3);
    expect(plainText(lines[1])).toBe(`${theme.glyphs.codeSide} const a`);
  });

  test("keeps inline markdown rendering after fenced-code support (AC-16)", () => {
    const lines = renderMarkdown("a **b** c", { width: WIDTH, theme });
    expect(lines).toHaveLength(1);
    expect(plainText(lines[0])).toBe("a b c");
  });

  test("draws a fence whose language collides with Object.prototype as plain code (AC-10)", () => {
    for (const language of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const spans = codeSpansOf(codeLineOf("const x = 1;", language));
      expect(spansText(spans)).toBe("const x = 1;");
      for (const span of spans) expect(span.color).toBeUndefined();
    }
  });

  test("strips escape sequences from the fence language label (AC-2)", () => {
    const screenSwitch = "\u001b[?1049l";
    const windowTitle = "\u001b]0;pwn\u0007";
    const lines = render(`${FENCE}ts${screenSwitch}${windowTitle}\nconst x = 1;\n${FENCE}`);
    expect(plainText(lines[0])).toBe(`${theme.glyphs.codeTop} ts`);
    for (const line of lines) {
      expect(plainText(line)).not.toContain("\u001b");
      expect(plainText(line)).not.toContain("\u0007");
    }
  });
});

describe("renderMarkdown fenced code highlighting fallback", () => {
  const highlight = _markdownDeps.highlight;

  afterEach(() => {
    _markdownDeps.highlight = highlight;
  });

  test("renders a fence whose highlighter throws without throwing itself (AC-14)", () => {
    _markdownDeps.highlight = () => {
      throw new Error("highlighter failed");
    };
    expect(() => render(fence("const x = 1;"))).not.toThrow();
    expect(texts(render(fence("const x = 1;")))).toHaveLength(3);
  });

  test("draws the code plain when the highlighter throws (AC-15)", () => {
    _markdownDeps.highlight = () => {
      throw new Error("highlighter failed");
    };
    const spans = codeSpansOf(codeLineOf("const x = 1;"));
    expect(spansText(spans)).toBe("const x = 1;");
    for (const span of spans) expect(span.color).toBeUndefined();
  });
});
