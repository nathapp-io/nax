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
 *
 * Two writers replace that comment's whole body (the report node and the ready-only waiver rewrite)
 * and the forge has no conditional update, so an entry can be lost from the block by a write built
 * from an older read. `mergeLedgerEntries` keeps push order across two such reads, and each push also
 * posts its own copy of its entry (`PUSH_RECORD_PREFIX`), which no summary rewrite can touch — see
 * `push-record.ts` for the reader that takes the two together.
 */
import { markerPattern, type OwnComment, withNaxBotMarker } from "@/forge";
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
/** A commit is named short, exactly as the fix summary names a push. */
const SHORT_SHA_LENGTH = 7;

const LEDGER_PREFIX = "<!-- nax-bot:pushes v1 ";
const LEDGER_SUFFIX = " -->";
/**
 * The payload is spelled permissively (`.*?`) on purpose: a block written by another version or
 * damaged in the comment still reads as a block, so `readPushLedger` can report it unreadable
 * instead of silently treating the comment as holding no ledger at all. A payload with an internal
 * space is exactly such damage, which a `\S*` payload would hide by not matching the line at all.
 */
const LEDGER_LINE = /<!-- nax-bot:pushes v1 (.*?) -->/;
const FULL_SHA = /^[0-9a-f]{40}$/;
/** Padded, canonical base64 in whole groups — the only form `encode` ever writes. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

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
  // `Buffer.from(…, "base64")` skips characters it cannot decode, so `W10=!` would read as `[]` and a
  // damaged history would look like an empty ledger — which the next push would then overwrite. The
  // payload must be the padded, canonical base64 `encode` writes before anything is decoded.
  if (!BASE64.test(payload)) return undefined;
  const bytes = Buffer.from(payload, "base64");
  // Decoding discards padding bits, so `W11=` and the canonical `W10=` both read as `[]`: only the
  // re-encoding of the decoded bytes proves the payload is byte-for-byte what `encode` wrote.
  if (bytes.toString("base64") !== payload) return undefined;
  try {
    return readEntries(JSON.parse(bytes.toString("utf8")) as unknown);
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

/**
 * One parent's issue, read from the push `Lineage:` names — never from whichever entry happens to hold
 * that key. A finding key recurs across pushes (a re-raised finding, an edit that keeps its key), so a
 * lookup by key alone can report an issue a different push wrote. A parent whose own push the ledger no
 * longer holds reads without an issue rather than borrowing another push's.
 */
export function parentIssue(pushSha: string, parent: string, entries: readonly BotPushEntry[]): string | undefined {
  return entries.find(({ sha }) => sha === pushSha)?.items.find(({ key }) => key === parent)?.issue;
}

function fits(entries: readonly BotPushEntry[]): boolean {
  return encode(entries).length <= MAX_LEDGER_CHARS;
}

/** The newest entries that fit the budget: the entry cap first, then the encoded block's own limit. */
function fitted(entries: readonly BotPushEntry[]): readonly BotPushEntry[] {
  let kept = entries.slice(-MAX_PUSH_ENTRIES);
  while (kept.length > 1 && !fits(kept)) kept = kept.slice(1);
  return kept;
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
  const kept = fitted([...entries, entry]);
  return fits(kept) ? kept : [trimItems(entry)];
}

/**
 * The union of two reads of the ledger, by full sha and in push order: the forge has no conditional
 * comment update, so a writer working from a stale read replaces the whole body and would otherwise
 * erase a push another run recorded while it worked.
 *
 * `earlier` is the older read (a snapshot, or the append-only copies a push posts), so an entry only it
 * holds is inserted where its own neighbours say it belongs — not simply in front, which would put it
 * ahead of entries every read agrees are older (B13). The entry cap and the block budget are applied
 * after this merge, so a recovered entry competes with its true age rather than looking like the oldest.
 */
export function mergeLedgerEntries(
  current: readonly BotPushEntry[],
  earlier: readonly BotPushEntry[],
): readonly BotPushEntry[] {
  const merged = [...current];
  const index = new Map<string, number>();
  const reindex = (): void => {
    index.clear();
    merged.forEach(({ sha }, at) => {
      index.set(sha, at);
    });
  };
  reindex();
  earlier.forEach((entry, at) => {
    if (index.has(entry.sha)) return;
    // The nearest earlier neighbour already merged decides: right after the one before, else right
    // before the one after, else in front of everything this read knows.
    const before = earlier
      .slice(0, at)
      .reverse()
      .find(({ sha }) => index.has(sha));
    const after = earlier.slice(at + 1).find(({ sha }) => index.has(sha));
    const afterAt = after === undefined ? undefined : index.get(after.sha);
    const wanted = before !== undefined ? (index.get(before.sha) ?? -1) + 1 : (afterAt ?? 0);
    merged.splice(afterAt === undefined ? wanted : Math.min(wanted, afterAt), 0, entry);
    reindex();
  });
  return merged;
}

/** Own-comment key prefix of the append-only copy of one push's entry (B1). */
export const PUSH_RECORD_PREFIX = "push-";

/** One push, in the identity grammar: the record is keyed by its full sha, so it is recorded once. */
export function pushRecordKey(sha: string): string {
  return `${PUSH_RECORD_PREFIX}${sha}`;
}

/**
 * The body a push posts as its own comment: the same block grammar the summary carries, so one reader
 * reads either. A posted comment is never rewritten by the summary writers, so this is the copy that a
 * summary rewrite cannot erase (B1). Its identity key is the push's full sha, so it is posted once.
 */
export function pushRecordBody(entry: BotPushEntry): string {
  const body = withPushLedger(`nax bot fix push ${entry.sha.slice(0, SHORT_SHA_LENGTH)} recorded for lineage.`, [
    entry,
  ]);
  return withNaxBotMarker(body, pushRecordKey(entry.sha));
}

/** The entries the append-only per-push records hold, in the order the PR lists them. */
export function pushRecordEntries(own: readonly OwnComment[]): readonly BotPushEntry[] {
  return own.flatMap((own) =>
    own.threadId === undefined && own.key.startsWith(PUSH_RECORD_PREFIX)
      ? readPushLedger(own.comment.body).entries
      : [],
  );
}

/** What this ledger adds to a comment: its block line with its newline, or nothing for an empty ledger. */
export function pushLedgerChars(entries: readonly BotPushEntry[]): number {
  return entries.length === 0 ? 0 : encode(entries).length + 1;
}

function readEntriesOf(body: string | undefined): readonly BotPushEntry[] {
  return body === undefined ? [] : readPushLedger(body).entries;
}

/**
 * The entries a report writes: the block the comment holds now, the entries an earlier read saw that
 * the current block lost, the append-only copies every push posts, and this execution's push when it
 * made one. US-008 reads the same list to count the pushes the summary is about to state, so the count
 * and the block can never disagree.
 */
export function nextLedgerEntries(input: NextLedgerInput): readonly BotPushEntry[] {
  const merged = mergeLedgerEntries(readEntriesOf(input.current), readEntriesOf(input.snapshot));
  const kept = mergeLedgerEntries(merged, input.records ?? []);
  return input.entry === undefined ? fitted(kept) : appendPushEntry(kept, input.entry);
}

/** The three reads a ledger write starts from, plus this execution's own push when it made one. */
export interface NextLedgerInput {
  /** The comment as the forge holds it at write time. */
  readonly current?: string | undefined;
  /** The body this execution first saw; its entries survive a stale rewrite. */
  readonly snapshot?: string | undefined;
  /** The append-only per-push records: the copies no summary rewrite can erase (B1). */
  readonly records?: readonly BotPushEntry[] | undefined;
  readonly entry?: BotPushEntry | undefined;
}

/**
 * The body a report writes: the `fix-summary` this execution rendered, carrying the ledger read above.
 * A write is always a whole-body replace, so callers pass the body the forge holds now as `current`
 * rather than the snapshot their run started with.
 */
export function ledgerBody(input: NextLedgerInput & { readonly body: string }): string {
  return withPushLedger(input.body, nextLedgerEntries(input));
}
