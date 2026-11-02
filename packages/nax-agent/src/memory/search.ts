/**
 * Keyword search over the mirror — the "did this note mention that?" lookup a
 * session runs before it starts work.
 *
 * Matching is whole-token and Unicode-aware, never substring: `replay` finds a
 * note about the replay budget and not one about something that "replays".
 * Tokenising the query and the note through the same function is what makes
 * that true by construction, on both sides of the comparison.
 *
 * Search is pure — notes in, hits out, no store, no filesystem, no provider —
 * so the ranking a caller sees is a function of its arguments alone.
 */
import type { MemoryHit, MemoryNote } from "./types.ts";

/** A run of Unicode letters and digits: everything else separates tokens. */
const TOKEN_RUN = /[\p{L}\p{N}]+/gu;

/** The shortest token worth matching: `a` and `2` carry no signal. */
const MIN_TOKEN_LENGTH = 2;

/** The distinct, lower-cased tokens of `text`, in first-occurrence order. */
export function tokenizeMemoryQuery(text: string): readonly string[] {
  const tokens = text.toLowerCase().match(TOKEN_RUN) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= MIN_TOKEN_LENGTH))];
}

/** The statuses a search may return: a note not yet pushed still counts, a dead one never does. */
const SEARCHABLE_STATUSES: ReadonlySet<MemoryNote["status"]> = new Set(["active", "pending"]);

/** How much of a body line a snippet keeps. */
const SNIPPET_MAX_CHARS = 160;

/** The line breaks a body is split on: `\n`, `\r\n` and a lone `\r`. */
const BODY_LINE_BREAK = /\r\n|\r|\n/;

/** A query token found in the note's own words is worth twice one found in its body. */
const HEAD_SCORE = 2;

/** A query token found only in the body still counts, once. */
const BODY_SCORE = 1;

/** The text of one note that ranks it highest: its name and its one-line summary. */
function headText(note: MemoryNote): string {
  return `${note.slug} ${note.description}`;
}

/** How much one note is worth for one query: 2 per head token, 1 per body token. */
function scoreNote(note: MemoryNote, queryTokens: readonly string[]): number {
  const head = new Set(tokenizeMemoryQuery(headText(note)));
  const body = new Set(tokenizeMemoryQuery(note.body));
  let score = 0;
  for (const token of queryTokens) {
    if (head.has(token)) score += HEAD_SCORE;
    if (body.has(token)) score += BODY_SCORE;
  }
  return score;
}

/** One note with the score the query gave it: the unit the ranking sorts. */
interface ScoredNote {
  readonly note: MemoryNote;
  readonly score: number;
}

/** The instant a timestamp names in epoch milliseconds, or null when it names none. */
function instantOf(updatedAt: string): number | null {
  const ms = Date.parse(updatedAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Newest first by the instant `updatedAt` names, not by its literal text: the
 * note codec accepts any non-empty single line, so two notes may carry the same
 * moment in different UTC offsets (`…T12:00:00+09:00` is `…T03:00:00Z`), and a
 * string compare would rank them wrongly. A value that names no instant falls
 * back to the literal compare, which keeps the order deterministic.
 */
function compareUpdatedDesc(a: string, b: string): number {
  if (a === b) return 0;
  const aMs = instantOf(a);
  const bMs = instantOf(b);
  if (aMs !== null && bMs !== null) return aMs === bMs ? 0 : aMs < bMs ? 1 : -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

/** Rank: score descending, then newest first, then slug ascending. */
function compareScored(a: ScoredNote, b: ScoredNote): number {
  if (a.score !== b.score) return b.score - a.score;
  const byUpdatedAt = compareUpdatedDesc(a.note.updatedAt, b.note.updatedAt);
  if (byUpdatedAt !== 0) return byUpdatedAt;
  return a.note.slug < b.note.slug ? -1 : a.note.slug > b.note.slug ? 1 : 0;
}

/** The first body line that holds one of the query's tokens, cut to a snippet. */
function snippetOf(body: string, queryTokens: readonly string[]): string {
  for (const line of body.split(BODY_LINE_BREAK)) {
    const lineTokens = new Set(tokenizeMemoryQuery(line));
    if (queryTokens.some((token) => lineTokens.has(token))) return line.slice(0, SNIPPET_MAX_CHARS);
  }
  return "";
}

/** Search the mirror's notes for the words in `text`. */
export function searchMemoryNotes(notes: readonly MemoryNote[], text: string, limit: number): readonly MemoryHit[] {
  const queryTokens = tokenizeMemoryQuery(text);
  if (queryTokens.length === 0 || limit <= 0) return [];
  const scored: ScoredNote[] = [];
  for (const note of notes) {
    if (!SEARCHABLE_STATUSES.has(note.status)) continue;
    const score = scoreNote(note, queryTokens);
    if (score > 0) scored.push({ note, score });
  }
  scored.sort(compareScored);
  return scored.slice(0, limit).map((ranked) => toHit(ranked, queryTokens));
}

/** The public shape of one ranked note. */
function toHit({ note, score }: ScoredNote, queryTokens: readonly string[]): MemoryHit {
  return {
    slug: note.slug,
    scope: note.scope,
    type: note.type,
    description: note.description,
    status: note.status,
    score,
    snippet: snippetOf(note.body, queryTokens),
  };
}
