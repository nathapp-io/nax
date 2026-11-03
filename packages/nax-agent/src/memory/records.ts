/**
 * The record files the mirror keeps beside its notes, decoded.
 *
 * `decisions.jsonl` is one `MemoryDecision` per line, `pending-forgets.jsonl` one
 * `MemoryPendingForget` per line, and `sync.json` is one `MemorySyncState`: all three are
 * written whole by this store and read back by it, so what makes a line a decision — or
 * a pending forget, or what makes a file a state — is a schema rather than a cast.
 * Keeping the schemas here leaves the store to decide what a refused line *means*
 * (skipped with a warning) and this module to decide what counts as one.
 */
import { z } from "zod";
import {
  MEMORY_CLIENT_ID_RE,
  MEMORY_DECISION_STATUSES,
  MEMORY_SCOPES,
  MEMORY_SLUG_RE,
  type MemoryDecision,
  type MemoryPendingForget,
} from "./types.ts";

/** A decision as one mirror line; the shape is what makes a line a decision. */
const DecisionSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  updatedAt: z.string().min(1),
  status: z.enum(MEMORY_DECISION_STATUSES),
});

/**
 * A pending forget as one mirror line. The slug and the client id are the two values
 * later code acts on — the slug names the note an approval retires, the client id names
 * the write — so a line carries a note slug and an outbox id, never an arbitrary string.
 */
const PendingForgetSchema = z.object({
  clientId: z.string().regex(MEMORY_CLIENT_ID_RE),
  scope: z.enum(MEMORY_SCOPES),
  slug: z.string().regex(MEMORY_SLUG_RE),
  reason: z.string(),
});

const SyncStateSchema = z.object({
  provider: z.string().nullable(),
  cursor: z.object({ project: z.string().nullable(), user: z.string().nullable() }),
  lastPullAt: z.string().nullable(),
  lastError: z.string().nullable(),
});

/** What `sync.json` holds: the shape the store's `MemorySyncState` is read back as. */
export type ParsedSyncState = z.infer<typeof SyncStateSchema>;

/** The state of a store that has never synced. */
export function defaultSyncState(): ParsedSyncState {
  return { provider: null, cursor: { project: null, user: null }, lastPullAt: null, lastError: null };
}

/** One decoded JSON value, or `null` when the text is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the caller decides whether that is a skipped line or a defaulted state.
    return null;
  }
}

/** One mirror line as a decision, or `null` when the line is not one. */
export function parseDecisionLine(line: string): MemoryDecision | null {
  const parsed = DecisionSchema.safeParse(parseJson(line));
  return parsed.success ? parsed.data : null;
}

/** One mirror line as a pending forget, or `null` when the line is not one. */
export function parsePendingForgetLine(line: string): MemoryPendingForget | null {
  const parsed = PendingForgetSchema.safeParse(parseJson(line));
  return parsed.success ? parsed.data : null;
}

/**
 * A JSONL record's text as its entries. A line the decoder refuses is skipped with one
 * report naming its 1-based line number, never fatal: the other lines are still the
 * record. A record file that is not there (`null`) is the empty record, not the absent
 * one — a store that has never recorded anything answers `[]` and creates nothing.
 */
export function decodeRecordLines<T>(
  text: string | null,
  decode: (line: string) => T | null,
  warnSkipped: (line: number) => void,
): T[] {
  if (text === null) return [];
  const entries: T[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    if (raw.trim() === "") continue;
    const entry = decode(raw);
    if (entry === null) {
      warnSkipped(index + 1);
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

/** One record file's text: one JSON object per line, and nothing at all when empty. */
export function encodeRecordLines(entries: readonly unknown[]): string {
  return entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

/** The whole `sync.json` text as a state, or `null` when it does not hold one. */
export function parseSyncStateText(text: string): ParsedSyncState | null {
  const parsed = SyncStateSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : null;
}
