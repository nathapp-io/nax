/**
 * Styled lines — the one rendering primitive every chat model produces.
 *
 * A `StyledLine` is an array of `Span`s and `StyledLineView` draws one line with the
 * theme's colours, so a model never carries a literal colour or glyph. Every width,
 * wrap and truncation in the layouts is measured with `displayWidth` (a width under
 * `MIN_LAYOUT_WIDTH` is treated as `MIN_LAYOUT_WIDTH`), and every text that comes from
 * the session, a tool, an MCP server or the host passes through `sanitizeText` before
 * it becomes span text — so a tool preview containing `\u001b[?1049l` cannot leave the
 * alternate screen.
 */
import { Text, type TextProps } from "ink";
import type { ReactElement } from "react";
import type { ChatColorToken, ChatTheme } from "./theme";

/** One run of text with one style. Colour is a theme token, never a literal. */
export interface Span {
  readonly text: string;
  readonly color?: ChatColorToken;
  readonly background?: ChatColorToken;
  readonly bold?: boolean;
  readonly italic?: boolean;
}

export type StyledLine = readonly Span[];

/** The narrowest width a layout may be given; anything less is treated as this. */
export const MIN_LAYOUT_WIDTH = 10;

/** A tab becomes two spaces so tool output keeps its column rhythm on screen. */
const TAB_WIDTH = 2;
const TAB_REPLACEMENT = " ".repeat(TAB_WIDTH);
const TAB_PATTERN = /\t/g;
const NEWLINE_CODE = 0x0a;
const FIRST_PRINTABLE_CODE = 0x20;
const DEL_CODE = 0x7f;

/** The line's text with every style dropped — for measuring and for tests. */
export function plainText(line: StyledLine): string {
  return line.map((span) => span.text).join("");
}

/** Terminal display columns: a CJK character or an emoji counts two. */
export function displayWidth(text: string): number {
  return Bun.stringWidth(text);
}

/**
 * Drop C0 controls other than a newline, plus DEL (0x7f). Iterating by code point
 * rather than matching a control-character class keeps the rule visible.
 */
function stripControls(text: string): string {
  let stripped = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    const printable = code >= FIRST_PRINTABLE_CODE && code !== DEL_CODE;
    if (printable || code === NEWLINE_CODE) stripped += character;
  }
  return stripped;
}

/**
 * Make text safe to draw: strip ANSI/OSC escape sequences, then C0 controls except
 * "\n" and DEL (0x7f); a tab becomes two spaces.
 */
export function sanitizeText(text: string): string {
  return stripControls(Bun.stripANSI(text).replace(TAB_PATTERN, TAB_REPLACEMENT));
}

function spanProps(span: Span, theme: ChatTheme): TextProps {
  return {
    color: span.color === undefined ? undefined : theme.colors[span.color],
    backgroundColor: span.background === undefined ? undefined : theme.colors[span.background],
    bold: span.bold,
    italic: span.italic,
  };
}

export interface StyledLineViewProps {
  readonly line: StyledLine;
  readonly theme: ChatTheme;
}

/** Render one styled line. A token the theme left undefined draws as the default. */
export function StyledLineView({ line, theme }: StyledLineViewProps): ReactElement {
  return (
    <Text>
      {line.map((span, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a StyledLine is an immutable value, re-rendered whole; span order never changes.
        <Text key={index} {...spanProps(span, theme)}>
          {span.text}
        </Text>
      ))}
    </Text>
  );
}
