/**
 * One outbox entry: the shape a queue file holds, and the codec that reads and rewrites it.
 *
 * It lives apart from `outbox.ts` because the queue's mechanics — the lock, the claim/removal
 * protocol, the sequence chain — and the entry's own model are two subjects, and the second is
 * what the drain, the operations and the CLI all read. Nothing here touches the filesystem: the
 * codec turns text into an entry, an entry into the state it is left in, and a name into the
 * sequence and client id it carries.
 *
 * The state an entry is in is the whole of what the rest of the system asks it:
 *
 * - `queued` — a write a sync will deliver, in `seq` order;
 * - `rejected` — refused for good; the reason is the record of why, and a CLI may requeue it;
 * - `uncertain` — dispatched and never answered by a provider that may not repeat it. It may
 *   have committed, so nothing sends it again and its key stays held, with the payload and the
 *   reason kept for an operator.
 */
import { z } from "zod";
import { byCodePoint, byNumber } from "#src/internal/sort";
import { parseMemoryNoteRecord } from "./note.ts";
import type { MemoryWriteRequest } from "./provider-types.ts";
import { MEMORY_CLIENT_ID_RE, MEMORY_SCOPES } from "./types.ts";

/** An entry file's name: the sequence, the client id that keys it, then the suffix. */
const ENTRY_FILE_RE = /^(\d{8})-([A-Za-z0-9_-]+)\.json$/;
const ENTRY_SEQ_DIGITS = 8;
const ENTRY_SUFFIX = ".json";

/** One queued write as the outbox holds it: the request plus where it sits in the order. */
export type MemoryOutboxEntry = MemoryWriteRequest & {
  readonly seq: number;
  readonly enqueuedAt: string;
  /**
   * Where the write stands.
   *
   * `queued` is a write a sync will deliver. `rejected` is a write refused for good, kept as the
   * record of the refusal. `uncertain` is a write that was dispatched and never answered by a
   * provider that may not repeat it: it may have committed, so nothing sends it again and it
   * keeps its key — a later write of the same note waits behind it until an operator requeues or
   * discards it.
   */
  readonly state: "queued" | "rejected" | "uncertain";
  /** The rejection reason once rejected; the request's own reason until then. */
  readonly reason?: string;
  /** A reason the request itself carried (a forget's justification), kept across a rejection. */
  readonly requestReason?: string;
  /** How many bad responses a push of this entry has met; absent until the first. */
  readonly badResponses?: number;
  /** The message of the last bad response, kept so a parked entry can say why. */
  readonly lastError?: string;
  /**
   * The client id of the entry this one waits on: a merge's source retire names the save of the
   * replacement it was folded into. It is queue bookkeeping, so it never reaches a provider
   * (`requestOf` in `sync-drain.ts` projects the request from the fields the two shapes share)
   * and it is read only by the drain, which refuses to deliver this entry once that one is gone
   * or refused.
   */
  readonly awaits?: string;
};

/**
 * Every field an entry file has to carry to be replayed; the note is checked separately.
 *
 * `reason` is read unbounded on purpose. A queued entry's reason is the forget's own
 * justification and a rejected one's is the provider's answer; the length a queued reason may
 * have is enforced where an entry is taken (`enqueue`), not where it is read — see this file's
 * header in `outbox.ts`. A read check would turn every entry written before that gate into an
 * invalid one.
 */
const EntrySchema = z.object({
  kind: z.enum(["save", "forget"]),
  clientId: z.string().regex(MEMORY_CLIENT_ID_RE),
  scope: z.enum(MEMORY_SCOPES),
  slug: z.string().min(1),
  writeMode: z.enum(["direct", "proposal"]),
  note: z.unknown().optional(),
  reason: z.string().optional(),
  requestReason: z.string().optional(),
  badResponses: z.number().int().positive().optional(),
  lastError: z.string().optional(),
  awaits: z.string().regex(MEMORY_CLIENT_ID_RE).optional(),
  seq: z.number().int().positive(),
  enqueuedAt: z.string().min(1),
  state: z.enum(["queued", "rejected", "uncertain"]),
});

/** One entry file: what its name says about it, before its content is read. */
export interface EntryFile {
  readonly name: string;
  readonly seq: number;
  readonly clientId: string;
}

/** An entry's file name; the sequence is padded so a plain name sort is a sequence sort. */
export function entryFileName(seq: number, clientId: string): string {
  return `${String(seq).padStart(ENTRY_SEQ_DIGITS, "0")}-${clientId}${ENTRY_SUFFIX}`;
}

/** The sequence and client id an entry file's name carries, or `null` when it is not one. */
export function entryFileNamed(name: string): EntryFile | null {
  const match = ENTRY_FILE_RE.exec(name);
  if (match === null) return null;
  return { name, seq: Number(match[1]), clientId: match[2] };
}

/** Entries in sequence order, with equal sequences ordered by client id. */
export function byEntryOrder(a: MemoryOutboxEntry, b: MemoryOutboxEntry): number {
  return byNumber(a.seq, b.seq) || byCodePoint(a.clientId, b.clientId);
}

/** One decoded JSON value, or `null` when the text is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the caller files the file name under listInvalid.
    return null;
  }
}

/** One file's text as an entry, or `null` when its content is not an entry. */
export function toEntry(text: string): MemoryOutboxEntry | null {
  const parsed = EntrySchema.safeParse(parseJson(text));
  if (!parsed.success) return null;
  const { note, ...rest } = parsed.data;
  if (note === undefined) return rest;
  try {
    return { ...rest, note: parseMemoryNoteRecord(note) };
  } catch {
    // A note the note schema refuses could never be replayed: the entry is not readable.
    return null;
  }
}

/**
 * One entry as an undelivered one: `reason` is why, and the caller says which state records it —
 * a permanent `rejected` refusal, or an `uncertain` hold whose dispatch may have committed.
 *
 * The reason the request itself carried — a forget's justification — is not lost to it; it moves
 * to `requestReason`. Re-marking an already undelivered entry replaces the reason and keeps the
 * original.
 */
export function undelivered(
  entry: MemoryOutboxEntry,
  state: "rejected" | "uncertain",
  reason: string,
): MemoryOutboxEntry {
  const { reason: currentReason, requestReason: keptReason, ...rest } = entry;
  const requestReason = keptReason ?? (entry.state === "queued" ? currentReason : undefined);
  return {
    ...rest,
    ...(requestReason === undefined ? {} : { requestReason }),
    state,
    reason,
  };
}

/** An undelivered entry as it was taken: the request's own reason back in `reason`, no count. */
export function toQueued(entry: MemoryOutboxEntry): MemoryOutboxEntry {
  const { reason: _reason, requestReason, badResponses: _count, lastError: _last, ...rest } = entry;
  return { ...rest, ...(requestReason === undefined ? {} : { reason: requestReason }), state: "queued" };
}
