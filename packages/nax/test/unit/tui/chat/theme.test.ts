import { describe, expect, test } from "bun:test";
import { type ChatColorToken, type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";

type ColorLevel = 0 | 1 | 2 | 3;
type Env = Readonly<Record<string, string | undefined>>;

const ALL_TOKENS = [
  "accent",
  "muted",
  "success",
  "warning",
  "danger",
  "diffAdd",
  "diffRemove",
  "userBand",
  "border",
  "borderFocus",
  "syntaxKeyword",
  "syntaxString",
  "syntaxComment",
  "syntaxNumber",
  "syntaxTitle",
] as const satisfies readonly ChatColorToken[];

const DARK_HEX = {
  accent: "#2bb5a3",
  muted: "#7d8f8c",
  success: "#4cc38a",
  warning: "#e5b84a",
  danger: "#f0625b",
  diffAdd: "#12352a",
  diffRemove: "#3d1a1c",
  userBand: "#17221f",
  border: "#2a3a37",
  borderFocus: "#2bb5a3",
  syntaxKeyword: "#d19af2",
  syntaxString: "#9ccc8a",
  syntaxComment: "#6f817e",
  syntaxNumber: "#e5a46c",
  syntaxTitle: "#7cc4f0",
} satisfies Record<ChatColorToken, string>;

const LIGHT_HEX = {
  accent: "#0f7f71",
  muted: "#6b7b78",
  success: "#1f8a55",
  warning: "#9a6b00",
  danger: "#c23a33",
  diffAdd: "#d7f2e3",
  diffRemove: "#fadcdb",
  userBand: "#eaf1ef",
  border: "#c7d3d0",
  borderFocus: "#0f7f71",
  syntaxKeyword: "#8a3fbf",
  syntaxString: "#2f7d32",
  syntaxComment: "#7a8a87",
  syntaxNumber: "#a65a14",
  syntaxTitle: "#1f6fae",
} satisfies Record<ChatColorToken, string>;

const ANSI_16 = {
  accent: "cyan",
  muted: "gray",
  success: "green",
  warning: "yellow",
  danger: "red",
  diffAdd: undefined,
  diffRemove: undefined,
  userBand: undefined,
  border: "gray",
  borderFocus: "cyan",
  syntaxKeyword: "magenta",
  syntaxString: "green",
  syntaxComment: "gray",
  syntaxNumber: "yellow",
  syntaxTitle: "blue",
} satisfies Record<ChatColorToken, string | undefined>;

const UNICODE_SPINNER = ["·", "✢", "✳", "✶", "✻", "✽"];
const ASCII_SPINNER = ["-", "\\", "|", "/"];

function theme(env: Env = {}, colorLevel: ColorLevel = 3): ChatTheme {
  return resolveChatTheme({ env, colorLevel });
}

function expectNoColors(resolved: ChatTheme): void {
  expect(Object.keys(resolved.colors).sort()).toEqual([...ALL_TOKENS].sort());
  for (const token of ALL_TOKENS) {
    expect(resolved.colors[token]).toBeUndefined();
  }
}

describe("resolveChatTheme — colour tokens", () => {
  test("AC-1: an empty environment at colour level 3 enables colour and a dark background", () => {
    const resolved = theme({}, 3);
    expect(resolved.color).toBe(true);
    expect(resolved.background).toBe("dark");
  });

  test("AC-2: accent resolves to the dark hex at colour level 3", () => {
    expect(theme({}, 3).colors.accent).toBe("#2bb5a3");
  });

  test("AC-2 (table): every token resolves to its dark hex at colour levels 2 and 3", () => {
    for (const level of [2, 3] as const) {
      expect(theme({}, level).colors).toEqual(DARK_HEX);
    }
  });

  test("AC-3: COLORFGBG '0;15' selects the light background and light hexes", () => {
    const resolved = theme({ COLORFGBG: "0;15" }, 3);
    expect(resolved.background).toBe("light");
    expect(resolved.colors.accent).toBe("#0f7f71");
    expect(resolved.colors).toEqual(LIGHT_HEX);
  });

  test("AC-3 (edge): only the last COLORFGBG field selects the background", () => {
    expect(theme({ COLORFGBG: "0;7" }, 3).background).toBe("light");
    expect(theme({ COLORFGBG: "0;8" }, 3).background).toBe("dark");
    expect(theme({ COLORFGBG: "" }, 3).background).toBe("dark");
  });

  test("AC-4: COLORFGBG '15;0' stays on the dark background", () => {
    expect(theme({ COLORFGBG: "15;0" }, 3).background).toBe("dark");
  });

  test("AC-5: colour level 1 resolves the accent to the 16-colour name", () => {
    expect(theme({}, 1).colors.accent).toBe("cyan");
  });

  test("AC-5 (table): every token resolves to its 16-colour name at colour level 1", () => {
    expect(theme({}, 1).color).toBe(true);
    expect(theme({}, 1).colors).toEqual(ANSI_16);
  });

  test("AC-6: background-only tokens are undefined at colour level 1", () => {
    const resolved = theme({}, 1);
    expect(resolved.colors.diffAdd).toBeUndefined();
    expect(resolved.colors.diffRemove).toBeUndefined();
    expect(resolved.colors.userBand).toBeUndefined();
  });

  test("AC-7: colour level 0 disables colour and leaves every token undefined", () => {
    const resolved = theme({}, 0);
    expect(resolved.color).toBe(false);
    expectNoColors(resolved);
  });

  test("AC-8: a non-empty NO_COLOR disables colour and leaves every token undefined", () => {
    const resolved = theme({ NO_COLOR: "1" }, 3);
    expect(resolved.color).toBe(false);
    expectNoColors(resolved);
  });

  test("AC-8 (edge): NO_COLOR '0' still disables colour — any non-empty value counts", () => {
    expect(theme({ NO_COLOR: "0" }, 3).color).toBe(false);
  });

  test("AC-9: an empty NO_COLOR keeps colour enabled", () => {
    const resolved = theme({ NO_COLOR: "" }, 3);
    expect(resolved.color).toBe(true);
    expect(resolved.colors).toEqual(DARK_HEX);
  });

  test("AC-10: TERM=dumb disables colour", () => {
    expect(theme({ TERM: "dumb" }, 3).color).toBe(false);
  });

  test("TERM other than dumb keeps colour enabled", () => {
    expect(theme({ TERM: "xterm-256color" }, 3).color).toBe(true);
  });
});

describe("resolveChatTheme — glyphs", () => {
  test("AC-11: an empty environment uses the Unicode bullet and result glyphs", () => {
    const resolved = theme({}, 3);
    expect(resolved.glyphs.bullet).toBe("⏺");
    expect(resolved.glyphs.result).toBe("⎿");
  });

  test("AC-11 (table): the full Unicode glyph set", () => {
    const { glyphs } = theme({}, 3);
    expect(glyphs.pointer).toBe("❯");
    expect(glyphs.modeGuarded).toBe("⏵");
    expect(glyphs.modeFull).toBe("⏵⏵");
    expect(glyphs.notice).toBe("※");
    expect(glyphs.warning).toBe("⚠");
    expect(glyphs.error).toBe("✗");
    expect(glyphs.thinking).toBe("✻");
    expect(glyphs.ellipsis).toBe("…");
    expect(glyphs.rule).toBe("─");
    expect(glyphs.codeTop).toBe("┌");
    expect(glyphs.codeSide).toBe("│");
    expect(glyphs.codeBottom).toBe("└");
    expect(glyphs.spinner).toEqual(UNICODE_SPINNER);
  });

  test("AC-12: NAX_ASCII=1 selects the ASCII bullet and spinner", () => {
    const resolved = theme({ NAX_ASCII: "1" }, 3);
    expect(resolved.glyphs.bullet).toBe("*");
    expect(resolved.glyphs.spinner).toEqual(["-", "\\", "|", "/"]);
  });

  test("AC-12 (table): the full ASCII glyph set", () => {
    const { glyphs } = theme({ NAX_ASCII: "1", LANG: "en_US.UTF-8" }, 3);
    expect(glyphs.result).toBe("|");
    expect(glyphs.pointer).toBe(">");
    expect(glyphs.modeGuarded).toBe(">");
    expect(glyphs.modeFull).toBe(">>");
    expect(glyphs.notice).toBe("-");
    expect(glyphs.warning).toBe("!");
    expect(glyphs.error).toBe("x");
    expect(glyphs.thinking).toBe("*");
    expect(glyphs.ellipsis).toBe("...");
    expect(glyphs.rule).toBe("-");
    expect(glyphs.codeTop).toBe("+");
    expect(glyphs.codeSide).toBe("|");
    expect(glyphs.codeBottom).toBe("+");
    expect(glyphs.spinner).toEqual(ASCII_SPINNER);
  });

  test("AC-12 (edge): NAX_ASCII values other than '1' keep the Unicode set", () => {
    expect(theme({ NAX_ASCII: "0" }, 3).glyphs.bullet).toBe("⏺");
    expect(theme({ NAX_ASCII: "" }, 3).glyphs.bullet).toBe("⏺");
    expect(theme({ NAX_ASCII: "true" }, 3).glyphs.bullet).toBe("⏺");
  });

  test("AC-13: a non-UTF-8 LANG selects the ASCII set", () => {
    expect(theme({ LANG: "C" }, 3).glyphs.bullet).toBe("*");
  });

  test("AC-13 (edge): LC_CTYPE is honoured when LC_ALL is unset", () => {
    expect(theme({ LC_CTYPE: "C", LANG: "en_US.UTF-8" }, 3).glyphs.bullet).toBe("*");
    expect(theme({ LC_CTYPE: "en_US.utf8", LANG: "C" }, 3).glyphs.bullet).toBe("⏺");
  });

  test("AC-14: LC_ALL takes precedence over a non-UTF-8 LANG", () => {
    expect(theme({ LC_ALL: "en_US.UTF-8", LANG: "C" }, 3).glyphs.bullet).toBe("⏺");
  });

  test("AC-14 (edge): an empty LC_ALL falls through to the next locale variable", () => {
    expect(theme({ LC_ALL: "", LC_CTYPE: "", LANG: "C" }, 3).glyphs.bullet).toBe("*");
    expect(theme({ LC_ALL: "", LANG: "ja_JP.UTF-8" }, 3).glyphs.bullet).toBe("⏺");
  });

  test("glyphs resolve independently of colour support", () => {
    const resolved = theme({ NO_COLOR: "1" }, 0);
    expect(resolved.color).toBe(false);
    expect(resolved.glyphs.bullet).toBe("⏺");
  });
});
