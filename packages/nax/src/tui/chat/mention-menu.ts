/**
 * The `@` picker's model: where the mention under the cursor starts and ends, which rows a
 * typed query keeps, and the editor state that choosing a row produces.
 *
 * The grammar is the one `mention-tokens.ts` reads on send, so a query is exactly the text a
 * completion would replace: an `@` at index 0 or after whitespace, a path running to the next
 * whitespace (or to the closing quote of a `@"…"` path). Unlike the send path, an incomplete
 * mention is a query — a bare `@` and an unclosed quote both open the picker, because a
 * completion has to start somewhere.
 *
 * `EditorState.cursor` counts code points while `MentionQuery.start` / `end` are raw string
 * offsets, since applying a row slices the text; the translation happens here so the editor's
 * Unicode contract is unchanged.
 */
import { formatMentionToken, type MentionFileRow } from "@/chat";
import type { EditorState } from "./line-editor";

/** A mention being typed: what to replace, the query the rows are filtered by, and its kind. */
export interface MentionQuery {
  /** Offset of the "@" in `EditorState.text`. */
  readonly start: number;
  /** Offset just past the token — where text after the mention resumes. */
  readonly end: number;
  /** The path text between the "@" (or `@"`) and the cursor. */
  readonly query: string;
  /** True when the mark is a `@"`, so the path may contain whitespace. */
  readonly quoted: boolean;
}

const MENTION_PREFIX = "@";
const MENTION_QUOTE = '"';
const SLASH_PREFIX = "/";
const WHITESPACE = /\s/;
const PATH_SEPARATOR = "/";
/** The space a completed token is followed by, so typing continues with a new word. */
const TOKEN_SEPARATOR = " ";

/** A basename that starts with the query — the row the user most likely meant. */
const RANK_BASENAME = 0;
/** A path that starts with the query after the folder prefix. */
const RANK_PREFIX = 1;
/** Any other match: the query is a subsequence only. */
const RANK_OTHER = 2;

/**
 * The mention the cursor is inside, or `null` when the prompt holds no mention there — a
 * slash-command line, a cursor past a whitespace, or a cursor on the `@` itself.
 */
export function mentionQueryAt(editor: EditorState): MentionQuery | null {
  if (editor.text.startsWith(SLASH_PREFIX)) return null;
  const cursor = offsetOf(editor.text, editor.cursor);
  for (let marker = cursor - 1; marker >= 0; marker--) {
    const query = queryAt(editor.text, marker, cursor);
    if (query !== null) return query;
  }
  return null;
}

/** The mention the mark at `marker` opens, when the cursor sits inside it. */
function queryAt(text: string, marker: number, cursor: number): MentionQuery | null {
  if (text.charAt(marker) !== MENTION_PREFIX || !startsMention(text, marker)) return null;
  return text.charAt(marker + 1) === MENTION_QUOTE
    ? quotedQuery(text, marker, cursor)
    : unquotedQuery(text, marker, cursor);
}

/** A mention starts at index 0 or right after whitespace, as on send. */
function startsMention(text: string, at: number): boolean {
  return at === 0 || WHITESPACE.test(text.charAt(at - 1));
}

function unquotedQuery(text: string, marker: number, cursor: number): MentionQuery | null {
  const from = marker + 1;
  if (WHITESPACE.test(text.slice(from, cursor))) return null;
  return { start: marker, end: nextWhitespace(text, cursor), query: text.slice(from, cursor), quoted: false };
}

/** A quoted path runs to the next `"`; one already closed before the cursor is not being typed. */
function quotedQuery(text: string, marker: number, cursor: number): MentionQuery | null {
  const from = marker + 2;
  const close = text.indexOf(MENTION_QUOTE, from);
  if (close >= 0 && close < cursor) return null;
  return {
    start: marker,
    end: close < 0 ? text.length : close + 1,
    query: text.slice(from, cursor),
    quoted: true,
  };
}

/** The offset of the next whitespace at or after `from`, or the end of the text. */
function nextWhitespace(text: string, from: number): number {
  for (let index = from; index < text.length; index++) {
    if (WHITESPACE.test(text.charAt(index))) return index;
  }
  return text.length;
}

/**
 * The rows a query keeps, best first: the direct children of the typed folder while no name
 * has been typed, then every row below it whose path the typed name is a subsequence of.
 */
export function filterMentionRows(rows: readonly MentionFileRow[], query: string): readonly MentionFileRow[] {
  const cut = query.lastIndexOf(PATH_SEPARATOR);
  const prefix = cut < 0 ? "" : query.slice(0, cut + 1);
  const rest = query.slice(prefix.length).toLowerCase();
  return rows
    .filter((row) => row.path !== prefix && row.path.startsWith(prefix))
    .filter((row) => keeps(row.path.slice(prefix.length), rest))
    .sort((a, b) => compareRows(a, b, prefix, rest));
}

/** Whether a candidate's path below the prefix answers the typed name. */
function keeps(after: string, rest: string): boolean {
  return rest === "" ? isDirectChild(after) : isSubsequence(rest, after.toLowerCase());
}

/** A direct child has no further separator, except the one a folder's own path ends with. */
function isDirectChild(after: string): boolean {
  return !after.replace(/\/$/, "").includes(PATH_SEPARATOR);
}

/** Case-insensitive subsequence match: "chh" keeps "chat-host.ts". */
function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const char of haystack) {
    if (char !== needle.charAt(index)) continue;
    index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function compareRows(a: MentionFileRow, b: MentionFileRow, prefix: string, rest: string): number {
  const rank = rankOf(a.path, prefix, rest) - rankOf(b.path, prefix, rest);
  if (rank !== 0) return rank;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return comparePaths(a.path, b.path);
}

function rankOf(path: string, prefix: string, rest: string): number {
  const lower = path.toLowerCase();
  if (basename(lower).startsWith(rest)) return RANK_BASENAME;
  return lower.slice(prefix.length).startsWith(rest) ? RANK_PREFIX : RANK_OTHER;
}

/** A path's last segment, with the trailing slash a folder row carries removed first. */
function basename(path: string): string {
  return path.replace(/\/$/, "").split(PATH_SEPARATOR).pop() ?? "";
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The prompt with the mention under the cursor replaced by the chosen row's token.
 *
 * Return completes a file or a folder and leaves a space after the token (stepping over the
 * whitespace already there rather than doubling it); tab on a folder only drills into it, so
 * the picker stays open on that folder's contents.
 */
export function applyMentionRow(
  editor: EditorState,
  at: MentionQuery,
  row: MentionFileRow,
  key: "tab" | "return",
): EditorState {
  const insertion = insertionFor(formatMentionToken(row.path), editor.text.charAt(at.end), row.folder && key === "tab");
  const text = `${editor.text.slice(0, at.start)}${insertion.text}${editor.text.slice(at.end)}`;
  return { text, cursor: codePointOf(text, at.start + insertion.caret) };
}

/** The text a chosen row inserts, and how far past `at.start` the cursor lands. */
interface Insertion {
  readonly text: string;
  readonly caret: number;
}

/** What a row inserts: a drilled-in folder, or a completed token followed by one space. */
function insertionFor(token: string, next: string, drillIn: boolean): Insertion {
  if (drillIn) {
    const text = drilledIn(token);
    return { text, caret: text.length };
  }
  // Either a space is inserted, or the whitespace already there is stepped over; the cursor
  // lands just past the token's separator in both cases, ready for the next word.
  const reuse = next !== "" && WHITESPACE.test(next);
  return { text: reuse ? token : `${token}${TOKEN_SEPARATOR}`, caret: token.length + 1 };
}

/** The token without its trailing space — and without its closing quote — so the quote stays open. */
function drilledIn(token: string): string {
  return token.endsWith(MENTION_QUOTE) ? token.slice(0, -1) : token;
}

/** The raw string offset of a code-point index, clamped into the text. */
function offsetOf(text: string, index: number): number {
  const chars = Array.from(text);
  return chars.slice(0, Math.min(Math.max(index, 0), chars.length)).join("").length;
}

/** The code-point index of a raw string offset, which is how `EditorState.cursor` counts. */
function codePointOf(text: string, offset: number): number {
  return Array.from(text.slice(0, Math.max(offset, 0))).length;
}
