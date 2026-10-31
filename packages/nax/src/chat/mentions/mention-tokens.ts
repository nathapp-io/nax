import type { MentionToken } from "./types";

const MENTION_PREFIX = "@";
const MENTION_QUOTE = '"';
const WHITESPACE = /\s/;

/**
 * Find every textual `@path` occurrence in a typed message.
 *
 * Purely textual: whether a token resolves to a real file is decided later, by the
 * expander. A mention starts at index 0 or right after whitespace; an empty path (a bare
 * "@" or `@""`) and an unclosed quote are not tokens.
 */
export function findMentionTokens(text: string): readonly MentionToken[] {
  const tokens: MentionToken[] = [];
  let index = 0;
  while (index < text.length) {
    const marker = text.indexOf(MENTION_PREFIX, index);
    if (marker < 0) break;
    const token = startsMention(text, marker) ? readToken(text, marker) : undefined;
    if (token === undefined) {
      index = marker + 1;
      continue;
    }
    tokens.push(token);
    index = token.end;
  }
  return tokens;
}

/** Render a path as a mention: quoted when it contains whitespace. */
export function formatMentionToken(path: string): string {
  return WHITESPACE.test(path)
    ? `${MENTION_PREFIX}${MENTION_QUOTE}${path}${MENTION_QUOTE}`
    : `${MENTION_PREFIX}${path}`;
}

function startsMention(text: string, at: number): boolean {
  return at === 0 || WHITESPACE.test(text.charAt(at - 1));
}

function readToken(text: string, start: number): MentionToken | undefined {
  return text.charAt(start + 1) === MENTION_QUOTE ? readQuotedToken(text, start) : readUnquotedToken(text, start);
}

/** A quoted path runs to the next `"`; there are no escape sequences. */
function readQuotedToken(text: string, start: number): MentionToken | undefined {
  const close = text.indexOf(MENTION_QUOTE, start + 2);
  const path = close < 0 ? "" : text.slice(start + 2, close);
  return path === "" ? undefined : { start, end: close + 1, path, quoted: true };
}

/** An unquoted path runs to the next whitespace or the end of the text. */
function readUnquotedToken(text: string, start: number): MentionToken | undefined {
  let end = start + 1;
  while (end < text.length && !WHITESPACE.test(text.charAt(end))) end += 1;
  const path = text.slice(start + 1, end);
  return path === "" ? undefined : { start, end, path, quoted: false };
}
