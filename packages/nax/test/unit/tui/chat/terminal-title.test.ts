/**
 * US-008: the terminal title the chat screen owns.
 *
 * The title names the project the chat was opened in, so a chat left in a background tab
 * says where it is; a busy marker in front of it says whether that chat is still working.
 * Everything here is a pure string: the two save/restore sequences, the OSC write and the
 * title text the screen composes for a busy and an idle turn.
 *
 * The busy marker comes from the theme's glyph set rather than a literal, so an ASCII
 * terminal gets `*` where a Unicode one gets `✳`, and the project name is stripped of
 * control characters before it is embedded — an OSC string ends at the first one.
 */
import { describe, expect, test } from "bun:test";
import { chatTitle, POP_TITLE, PUSH_TITLE, setTitleSequence } from "@/tui/chat/terminal-title";
import { type ChatGlyphs, resolveChatTheme } from "@/tui/chat/theme";

/** The glyph set an empty environment resolves, and the one `NAX_ASCII=1` forces. */
const UNICODE = resolveChatTheme({ env: {}, colorLevel: 0 }).glyphs;
const ASCII = resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 0 }).glyphs;

describe("chatTitle", () => {
  test("AC-1 states the app and the project while no turn runs", () => {
    expect(chatTitle("my-repo", false, UNICODE)).toBe("nax · my-repo");
  });

  test("AC-2 puts the Unicode busy glyph in front of the title", () => {
    expect(chatTitle("my-repo", true, UNICODE)).toBe("✳ nax · my-repo");
  });

  test("AC-3 takes the busy glyph from the glyph set, so ASCII draws a plain star", () => {
    expect(chatTitle("my-repo", true, ASCII)).toBe("* nax · my-repo");
  });

  test("AC-4 strips the control characters a project name could carry into the OSC string", () => {
    // An OSC title ends at the first BEL, so a control byte in the project would truncate it.
    expect(chatTitle("a\u0007b", false, UNICODE)).toBe("nax · ab");
  });

  test("AC-4 (edge) strips every C0, DEL and C1 control and keeps the rest", () => {
    const controls = "\u0000\u0007\u001b\u001f\u007f\u0085\u009f";
    expect(chatTitle(`${controls}my-repo${controls}`, false, UNICODE)).toBe("nax · my-repo");
    expect(chatTitle("my\u0009-repo", false, UNICODE)).toBe("nax · my-repo");
  });

  test("composes the busy marker from the glyph set, never a hardcoded character", () => {
    const custom: ChatGlyphs = { ...UNICODE, busy: "@" };
    expect(chatTitle("my-repo", true, custom)).toBe("@ nax · my-repo");
    expect(chatTitle("my-repo", false, custom)).toBe("nax · my-repo");
  });
});

describe("setTitleSequence", () => {
  test("AC-5 wraps the text in the OSC 0 sequence, terminated by BEL", () => {
    expect(setTitleSequence("x")).toBe("\u001b]0;x\u0007");
    expect(setTitleSequence("nax · my-repo")).toBe("\u001b]0;nax · my-repo\u0007");
  });
});

describe("the title push and pop sequences", () => {
  test("AC-6 PUSH_TITLE saves the terminal's current title", () => {
    expect(PUSH_TITLE).toBe("\u001b[22;0t");
  });

  test("AC-7 POP_TITLE restores the title PUSH_TITLE saved", () => {
    expect(POP_TITLE).toBe("\u001b[23;0t");
  });
});
