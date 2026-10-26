/**
 * Status entries — the lines the transcript draws for the screen's own statements rather
 * than the model's words: the welcome banner at mount, a notice, a warning, an error and an
 * interruption.
 *
 * Each is a glyph and its text, coloured by what it says, and each is measured in the
 * layout's columns by the shared engine in `layout-lines.ts`: a long notice wraps at a word
 * boundary with blank columns as wide as its glyph on every continuation. A status entry is
 * one statement, so text the host supplies with a line break in it is flattened to one row
 * before it is wrapped — the break is data, not formatting. Every such string passes through
 * `sanitizeText` before it becomes span text.
 *
 * The banner's counts are the entry's own numbers (US-020 collects them from the host), so
 * this module never reads the host and a missing catalogue is simply the entry's zeros.
 */
import { EMPTY_LINE, type LayoutContext, oneLine, prefixedLine, resultPrefix, SPACE, styled } from "./layout-lines";
import { type StyledLine, sanitizeText } from "./styled-line";
import type { ChatColorToken, ChatGlyphs } from "./theme";
import type { TranscriptEntry } from "./transcript-model";

type WelcomeEntry = Extract<TranscriptEntry, { kind: "welcome" }>;
type StatusEntry = Extract<TranscriptEntry, { kind: "notice" | "warning" | "error" }>;

/** The banner's first line: the thinking glyph and the product's name. */
const WELCOME_TITLE = "nax chat";
/** The banner's closing line: where a new session goes first. */
const WELCOME_TIPS = "/feature <name> loads a spec · /resume picks a session · /help lists commands";
/** What separates one count from the next on the banner's summary line. */
const COUNT_SEPARATOR = " · ";
/** The row an interrupted turn leaves behind. */
const INTERRUPTED = "Interrupted by user";

/** The glyph and the colour each status entry draws with. */
const STATUS_STYLE = {
  notice: { glyph: "notice", color: "muted" },
  warning: { glyph: "warning", color: "warning" },
  error: { glyph: "error", color: "danger" },
} as const satisfies Record<StatusEntry["kind"], { readonly glyph: keyof ChatGlyphs; readonly color: ChatColorToken }>;

/** The banner's summary line: what the session has to work with, and how much is live. */
function countParts(entry: WelcomeEntry): readonly string[] {
  return [
    `skills ${entry.skills}`,
    `commands ${entry.commands}`,
    `mcp ${entry.mcpServers} (${entry.mcpConnected} connected)`,
    `agents ${entry.agents}`,
  ];
}

/** One line of text at the layout's width, wrapped with no indent of its own. */
function rowsOf(text: string, color: ChatColorToken, context: LayoutContext): readonly StyledLine[] {
  return prefixedLine([styled(text, { color })], [], context);
}

/**
 * The welcome banner: `✻ nax chat` in the accent colour, an empty line, then the counts and
 * the tips — both muted, and both wrapped like any other line so a narrow terminal keeps
 * every one of them.
 */
export function welcomeLines(entry: WelcomeEntry, context: LayoutContext): readonly StyledLine[] {
  const glyph = styled(`${context.theme.glyphs.thinking}${SPACE}`, { color: "accent", bold: true });
  const title = styled(WELCOME_TITLE, { color: "accent", bold: true });
  return [
    ...prefixedLine([title], [glyph], context),
    EMPTY_LINE,
    ...rowsOf(countParts(entry).join(COUNT_SEPARATOR), "muted", context),
    ...rowsOf(WELCOME_TIPS, "muted", context),
  ];
}

/**
 * A notice, a warning or an error: its glyph and a space, then the text in the colour that
 * carries the severity. The glyph and the text share the colour — the line is one statement
 * — and a wrapped continuation starts under the text, clear of the glyph.
 */
export function statusLines(entry: StatusEntry, context: LayoutContext): readonly StyledLine[] {
  const { glyph, color } = STATUS_STYLE[entry.kind];
  const prefix = styled(`${context.theme.glyphs[glyph]}${SPACE}`, { color });
  return prefixedLine([styled(oneLine(sanitizeText(entry.text)), { color })], [prefix], context);
}

/**
 * An interruption: the result glyph behind the reply gutter and the reason, muted. It is
 * drawn where a card's result summary starts, because it is what the host said about the
 * turn rather than anything the model wrote.
 */
export function interruptedLines(context: LayoutContext): readonly StyledLine[] {
  const prefix = styled(resultPrefix(context.theme), { color: "muted" });
  return prefixedLine([styled(INTERRUPTED, { color: "muted" })], [prefix], context);
}
