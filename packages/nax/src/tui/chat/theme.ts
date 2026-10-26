/**
 * Chat theme — one `ChatTheme` resolved from the environment and the terminal's
 * colour level.
 *
 * The theme is the SSOT for every colour and glyph the `nax chat` screen draws:
 * the styled-line primitives (`styled-line.tsx`) and every model that produces
 * them carry tokens and glyph references, never literal colours or characters.
 *
 * Resolution is a pure function of `{ env, colorLevel }`, so a test (or a
 * caller with a captured environment) can resolve the exact theme the terminal
 * would see without touching `process.env`.
 */

/** Every colour slot the chat screen may use. */
export type ChatColorToken =
  | "accent"
  | "muted"
  | "success"
  | "warning"
  | "danger"
  | "diffAdd"
  | "diffRemove"
  | "userBand"
  | "border"
  | "borderFocus"
  | "syntaxKeyword"
  | "syntaxString"
  | "syntaxComment"
  | "syntaxNumber"
  | "syntaxTitle";

/** The character set all chat models draw with. */
export interface ChatGlyphs {
  readonly bullet: string;
  readonly result: string;
  readonly pointer: string;
  readonly modeGuarded: string;
  readonly modeFull: string;
  readonly notice: string;
  readonly warning: string;
  readonly error: string;
  readonly thinking: string;
  readonly ellipsis: string;
  readonly rule: string;
  readonly codeTop: string;
  readonly codeSide: string;
  readonly codeBottom: string;
  readonly spinner: readonly string[];
}

export interface ChatTheme {
  readonly color: boolean;
  readonly background: "dark" | "light";
  /** Ink colour strings; undefined = terminal default (and no background for bg tokens). */
  readonly colors: Readonly<Record<ChatColorToken, string | undefined>>;
  readonly glyphs: ChatGlyphs;
}

type ChatColorLevel = 0 | 1 | 2 | 3;
type ChatEnv = Readonly<Record<string, string | undefined>>;

/** 24-bit colours, picked for a dark terminal background. */
const DARK_HEX_COLORS = {
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
} as const satisfies Record<ChatColorToken, string>;

/** 24-bit colours, picked for a light terminal background. */
const LIGHT_HEX_COLORS = {
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
} as const satisfies Record<ChatColorToken, string>;

/**
 * 16-colour fallback. Ink's named colours are terminal-default-aware, so a
 * light terminal stays readable without a second table. Tokens that only ever
 * paint a *background* have no safe 16-colour equivalent and stay undefined,
 * which renders as the terminal default instead of a muddy band.
 */
const ANSI_COLORS = {
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
} as const satisfies Record<ChatColorToken, string | undefined>;

/** Colour-off theme: every token present, every value undefined. */
const NO_COLORS = {
  accent: undefined,
  muted: undefined,
  success: undefined,
  warning: undefined,
  danger: undefined,
  diffAdd: undefined,
  diffRemove: undefined,
  userBand: undefined,
  border: undefined,
  borderFocus: undefined,
  syntaxKeyword: undefined,
  syntaxString: undefined,
  syntaxComment: undefined,
  syntaxNumber: undefined,
  syntaxTitle: undefined,
} as const satisfies Record<ChatColorToken, string | undefined>;

const UNICODE_GLYPHS: ChatGlyphs = {
  bullet: "⏺",
  result: "⎿",
  pointer: "❯",
  modeGuarded: "⏵",
  modeFull: "⏵⏵",
  notice: "※",
  warning: "⚠",
  error: "✗",
  thinking: "✻",
  ellipsis: "…",
  rule: "─",
  codeTop: "┌",
  codeSide: "│",
  codeBottom: "└",
  spinner: ["·", "✢", "✳", "✶", "✻", "✽"],
};

const ASCII_GLYPHS: ChatGlyphs = {
  bullet: "*",
  result: "|",
  pointer: ">",
  modeGuarded: ">",
  modeFull: ">>",
  notice: "-",
  warning: "!",
  error: "x",
  thinking: "*",
  ellipsis: "...",
  rule: "-",
  codeTop: "+",
  codeSide: "|",
  codeBottom: "+",
  spinner: ["-", "\\", "|", "/"],
};

/** `NAX_ASCII=1` forces the ASCII glyph set regardless of locale. */
const NAX_ASCII = "NAX_ASCII";
const NAX_ASCII_ON = "1";

/** First non-empty variable wins, in this order. */
const LOCALE_VARS = ["LC_ALL", "LC_CTYPE", "LANG"] as const;
const UTF8_LOCALE_PATTERN = /utf-?8/i;

/** COLORFGBG's last field is the background ANSI colour index; 7 and 15 are the light ones. */
const LIGHT_BACKGROUND_INDEXES = ["7", "15"] as const;
const COLORFGBG = "COLORFGBG";
const NO_COLOR = "NO_COLOR";
const TERM = "TERM";
const DUMB_TERM = "dumb";

function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/**
 * Colour is off at level 0, whenever `NO_COLOR` holds any non-empty value
 * (see no-color.org), and for a `dumb` terminal.
 */
function supportsColor(env: ChatEnv, colorLevel: ChatColorLevel): boolean {
  if (colorLevel === 0) return false;
  if (isSet(env[NO_COLOR])) return false;
  return env[TERM] !== DUMB_TERM;
}

function resolveBackground(env: ChatEnv): "dark" | "light" {
  const lastField = env[COLORFGBG]?.split(";").at(-1);
  if (lastField === undefined) return "dark";
  return LIGHT_BACKGROUND_INDEXES.some((index) => index === lastField) ? "light" : "dark";
}

function resolveColors(
  background: "dark" | "light",
  colorLevel: ChatColorLevel,
  color: boolean,
): Readonly<Record<ChatColorToken, string | undefined>> {
  if (!color) return NO_COLORS;
  if (colorLevel === 1) return ANSI_COLORS;
  return background === "light" ? LIGHT_HEX_COLORS : DARK_HEX_COLORS;
}

function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (isSet(value)) return value;
  }
  return undefined;
}

/**
 * The Unicode set is used unless ASCII is requested explicitly or the active
 * locale is not UTF-8. With no locale set at all the terminal is assumed
 * capable, which is what the rest of the CLI ecosystem assumes too.
 */
function resolveGlyphs(env: ChatEnv): ChatGlyphs {
  if (env[NAX_ASCII] === NAX_ASCII_ON) return ASCII_GLYPHS;
  const locale = firstNonEmpty(LOCALE_VARS.map((name) => env[name]));
  if (locale === undefined) return UNICODE_GLYPHS;
  return UTF8_LOCALE_PATTERN.test(locale) ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

/**
 * Resolve the chat theme for a captured environment and the terminal's colour
 * level (0 none, 1 basic, 2 256-colour, 3 truecolour).
 */
export function resolveChatTheme(input: {
  env: Readonly<Record<string, string | undefined>>;
  colorLevel: 0 | 1 | 2 | 3;
}): ChatTheme {
  const color = supportsColor(input.env, input.colorLevel);
  const background = resolveBackground(input.env);
  return {
    color,
    background,
    colors: resolveColors(background, input.colorLevel, color),
    glyphs: resolveGlyphs(input.env),
  };
}
