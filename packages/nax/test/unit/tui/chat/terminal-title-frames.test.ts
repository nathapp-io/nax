import { describe, expect, test } from "bun:test";
import { chatTitleFrame, TITLE_FRAME_MS, titleFrames } from "@/tui/chat/terminal-title";
import { type ChatGlyphs, resolveChatTheme } from "@/tui/chat/theme";

const unicode = resolveChatTheme({ env: {}, colorLevel: 0 }).glyphs;

describe("TITLE_FRAME_MS", () => {
  test("AC-1: is 400", () => {
    expect(TITLE_FRAME_MS).toBe(400);
  });
});

describe("titleFrames", () => {
  test("AC-2: returns the unicode spinner frames", () => {
    expect(titleFrames(unicode)).toEqual(unicode.spinner);
    expect(unicode.spinner.length).toBeGreaterThan(1);
  });

  test("AC-3: falls back to the busy glyph for a one-frame spinner", () => {
    const glyphs: ChatGlyphs = { ...unicode, spinner: ["x"] };
    expect(titleFrames(glyphs)).toEqual([glyphs.busy]);
  });

  test("AC-4: falls back to the busy glyph for an empty spinner", () => {
    const glyphs: ChatGlyphs = { ...unicode, spinner: [] };
    expect(titleFrames(glyphs)).toEqual([glyphs.busy]);
  });
});

describe("chatTitleFrame", () => {
  test("AC-5: prefixes the idle title with the frame", () => {
    expect(chatTitleFrame("repo", "✶")).toBe("✶ nax · repo");
  });

  test("AC-6: strips control characters from the project", () => {
    expect(chatTitleFrame("re\u0007po", "✶")).toBe("✶ nax · repo");
  });
});
