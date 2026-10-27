import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import {
  displayWidth,
  MIN_LAYOUT_WIDTH,
  plainText,
  type StyledLine,
  StyledLineView,
  sanitizeText,
} from "@/tui/chat/styled-line";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";

/** Colour off: every token undefined, so the frame is the plain span text. */
const NO_COLOR_THEME: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 0 });
/** 16-colour: colour on, but `userBand` (a background-only token) is undefined. */
const ANSI_THEME: ChatTheme = resolveChatTheme({ env: {}, colorLevel: 1 });

afterEach(() => {
  cleanup();
});

/** Render one line and return the frame the terminal would show for it. */
function frameText(line: StyledLine, theme: ChatTheme): string {
  const { lastFrame } = render(<StyledLineView line={line} theme={theme} />);
  return (lastFrame() ?? "").trim();
}

describe("plainText", () => {
  test("joins every span's text in order", () => {
    expect(plainText([{ text: "a" }, { text: "b", bold: true }])).toBe("ab");
  });

  test("returns an empty string for an empty line", () => {
    expect(plainText([])).toBe("");
  });
});

describe("displayWidth", () => {
  test("counts one column per ASCII character", () => {
    expect(displayWidth("ab")).toBe(2);
  });

  test("counts two columns per CJK character", () => {
    expect(displayWidth("日本")).toBe(4);
  });

  test("ignores escape sequences that are still in the text", () => {
    expect(displayWidth("\u001b[31mab\u001b[0m")).toBe(2);
  });
});

const SANITIZE_CASES: [name: string, input: string, expected: string][] = [
  ["strips a CSI colour sequence", "a\u001b[31mb\u001b[0m", "ab"],
  ["strips a CSI private-mode sequence", "x\u001b[?1049ly", "xy"],
  ["strips an OSC title terminated by BEL", "a\u001b]0;title\u0007b", "ab"],
  ["expands a tab to two spaces", "a\tb", "a  b"],
  ["strips carriage return, BEL and DEL", "a\rb\u0007c\u007f", "abc"],
  ["keeps newlines", "a\nb", "a\nb"],
];

describe("sanitizeText", () => {
  test.each(SANITIZE_CASES)("%s", (_name, input, expected) => {
    expect(sanitizeText(input)).toBe(expected);
  });

  test("leaves plain text untouched", () => {
    expect(sanitizeText("hello world")).toBe("hello world");
  });
});

describe("MIN_LAYOUT_WIDTH", () => {
  test("is the narrowest width a layout may be given", () => {
    expect(MIN_LAYOUT_WIDTH).toBe(10);
  });
});

describe("StyledLineView", () => {
  test("renders a colourless theme's spans as plain frame text", () => {
    expect(frameText([{ text: "hi", color: "accent" }], NO_COLOR_THEME)).toBe("hi");
  });

  test("renders a span whose background token is undefined without throwing", () => {
    expect(frameText([{ text: "x", background: "userBand" }], ANSI_THEME)).toBe("x");
  });

  test("renders every span of one line in order", () => {
    expect(frameText([{ text: "a" }, { text: "b" }], NO_COLOR_THEME)).toBe("ab");
  });

  test("renders bold and italic spans", () => {
    expect(frameText([{ text: "b", bold: true, italic: true }], NO_COLOR_THEME)).toContain("b");
  });

  test("renders an empty line as nothing", () => {
    expect(frameText([], NO_COLOR_THEME)).toBe("");
  });
});
