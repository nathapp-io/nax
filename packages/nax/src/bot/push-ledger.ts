/**
 * The bot's own bounded record of the pushes it made (spec bot-convergence-facts US-004).
 *
 * `nax bot fix` publishes one `fix-summary` comment and edits it in place. This module carries the
 * machine-readable tail of that comment: one line
 * `<!-- nax-bot:pushes v1 <base64 of a JSON array> -->`, which `markerPattern` does not match, so it
 * is neither an identity marker nor a comment that `ownComments` could mistake for one. A later
 * review reads it back to tell which finding sits on lines an earlier bot push wrote (US-005).
 *
 * Two budgets keep the public comment small: at most `MAX_PUSH_ENTRIES` entries, and an encoded
 * block of at most `MAX_LEDGER_CHARS` characters — well under the forge's 65,536-character comment
 * limit, leaving room for the summary text beside it.
 *
 * A block this module cannot decode is `unreadable`, never partly trusted: a half-read record would
 * date findings to a push that never wrote their lines, so the reader reports nothing and the next
 * push replaces the block with what it knows.
 */
import { markerPattern } from "@/forge";
import { firstIssueLine } from "@/workflow/blocking-findings";

export interface BotPushItem {
  readonly key: string;
  readonly generation: number;
  readonly issue: string;
}

export interface BotPushEntry {
  readonly base: string;
  readonly sha: string;
  readonly at: string;
  readonly items: readonly BotPushItem[];
}

/** Where a finding's lines came from (US-005): the push that added them and the items it fixed. */
export interface FindingLineage {
  readonly generation: number;
  readonly parents: readonly string[];
  readonly pushSha: string;
}

export const MAX_PUSH_ENTRIES = 64;
/** Encoded block budget, well under the forge's 65,536-character comment limit. */
export const MAX_LEDGER_CHARS = 24_000;
/** An item names one finding; the block stays small even at the entry cap. */
const MAX_ITEM_ISSUE_CHARS = 120;

const LEDGER_PREFIX = "<!-- nax-bot:pushes v1 ";
const LEDGER_SUFFIX = " -->";
/**
 * The payload is spelled permissively (`\S*`) on purpose: a block written by another version or
 * damaged in the comment still reads as a block, so `readPushLedger` can report it unreadable
 * instead of silently treating the comment as holding no ledger at all.
 */
const LEDGER_LINE = /<!-- nax-bot:pushes v1 (\S*) -->/;
const FULL_SHA = /^[0-9a-f]{40}$/;

function isLedgerLine(line: string): boolean {
  return LEDGER_LINE.test(line);
}

/** `markerPattern` is the identity grammar; a fresh regex per line carries no `lastIndex` state. */
function isMarkerLine(line: string): boolean {
  return markerPattern().test(line);
}

function encode(entries: readonly BotPushEntry[]): string {
  return `${LEDGER_PREFIX}${Buffer.from(JSON.stringify(entries), "utf8").toString("base64")}${LEDGER_SUFFIX}`;
}

function readItem(value: unknown): BotPushItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { key, generation, issue } = value as Record<string, unknown>;
  if (typeof key !== "string" || typeof generation !== "number" || typeof issue !== "string") return undefined;
  return { key, generation, issue };
}

function readItems(values: readonly unknown[]): BotPushItem[] | undefined {
  const items: BotPushItem[] = [];
  for (const value of values) {
    const item = readItem(value);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
}

function readEntry(value: unknown): BotPushEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { base, sha, at, items } = value as Record<string, unknown>;
  if (typeof base !== "string" || typeof sha !== "string" || !FULL_SHA.test(sha) || !Array.isArray(items))
    return undefined;
  const read = readItems(items);
  if (read === undefined) return undefined;
  // `base`, `sha` and `items` are what a reader uses (US-004); a missing timestamp is only cosmetic.
  return { base, sha, at: typeof at === "string" ? at : "", items: read };
}

function readEntries(decoded: unknown): BotPushEntry[] | undefined {
  if (!Array.isArray(decoded)) return undefined;
  const entries: BotPushEntry[] = [];
  for (const value of decoded) {
    const entry = readEntry(value);
    if (entry === undefined) return undefined;
    entries.push(entry);
  }
  return entries;
}

function parsePayload(payload: string): readonly BotPushEntry[] | undefined {
  try {
    return readEntries(JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as unknown);
  } catch {
    // A payload that is not base64 JSON is not a ledger: the caller reports it unreadable.
    return undefined;
  }
}

/** The ledger this body carries. A body with no block holds an empty, perfectly readable one. */
export function readPushLedger(body: string): { entries: readonly BotPushEntry[]; unreadable: boolean } {
  const match = LEDGER_LINE.exec(body);
  if (match === null) return { entries: [], unreadable: false };
  const entries = parsePayload(match[1] ?? "");
  return entries === undefined ? { entries: [], unreadable: true } : { entries, unreadable: false };
}

/** Immediately before the identity marker line, so a reader sees the summary first and the state last. */
function insertBeforeMarker(lines: readonly string[], block: string): string {
  let at = -1;
  lines.forEach((line, index) => {
    if (isMarkerLine(line)) at = index;
  });
  const next = [...lines];
  if (at === -1) next.push(block);
  else next.splice(at, 0, block);
  return next.join("\n");
}

/**
 * The body with this ledger: the existing block replaced (or removed, for an empty list) and the new
 * one placed immediately before the body's `nax-bot:v1` marker line.
 */
export function withPushLedger(body: string, entries: readonly BotPushEntry[]): string {
  const kept = body.split("\n").filter((line) => !isLedgerLine(line));
  return entries.length === 0 ? kept.join("\n") : insertBeforeMarker(kept, encode(entries));
}

/** One item's issue: the finding's first line, capped so a single entry cannot crowd the budget. */
export function ledgerIssue(issue: string): string {
  return firstIssueLine(issue).slice(0, MAX_ITEM_ISSUE_CHARS);
}

function fits(entries: readonly BotPushEntry[]): boolean {
  return encode(entries).length <= MAX_LEDGER_CHARS;
}

/** A single entry over the budget keeps only the leading items that fit, so the push is still recorded. */
function trimItems(entry: BotPushEntry): BotPushEntry {
  let count = entry.items.length;
  while (count > 0 && !fits([{ ...entry, items: entry.items.slice(0, count) }])) count--;
  return { ...entry, items: entry.items.slice(0, count) };
}

/**
 * The ledger with this push appended: newest `MAX_PUSH_ENTRIES` entries, then the oldest dropped until
 * the encoded block fits `MAX_LEDGER_CHARS`. The appended entry is never the one dropped.
 */
export function appendPushEntry(entries: readonly BotPushEntry[], entry: BotPushEntry): readonly BotPushEntry[] {
  let kept = [...entries, entry].slice(-MAX_PUSH_ENTRIES);
  while (kept.length > 1 && !fits(kept)) kept = kept.slice(1);
  return fits(kept) ? kept : [trimItems(entry)];
}

/**
 * The body a report writes: the `fix-summary` this execution rendered, carrying the ledger of the
 * comment it replaces plus — only when this execution pushed — its own entry. An unreadable or
 * absent previous block contributes nothing but the new entry (US-004).
 */
export function ledgerBody(previous: string | undefined, entry: BotPushEntry | undefined, body: string): string {
  const kept = previous === undefined ? [] : readPushLedger(previous).entries;
  return withPushLedger(body, entry === undefined ? kept : appendPushEntry(kept, entry));
}
