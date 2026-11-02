/**
 * The outbox: the writes the agent has taken but a provider has not
 * acknowledged, held on disk until a sync delivers them.
 *
 * One JSON file per entry, `<seq padded to 8 digits>-<clientId>.json`, written
 * whole through `writeFileAtomic`: the bytes land in a sibling `.tmp` stage and
 * are renamed over the entry name, so a crash leaves either the old entry or
 * none, never a torn one, and a reader never sees a half-written file. `seq`
 * numbers the entries in the order they were taken. It is assigned inside a
 * promise chain local to this instance, so two concurrent `enqueue` calls on
 * one outbox get distinct sequences; a second process writing the same
 * directory is outside that chain and may hand out an equal sequence, which is
 * why `list` breaks a tie by client id — the order stays deterministic rather
 * than globally correct.
 *
 * A file whose name matches the entry pattern but whose content is not an entry
 * is never silently dropped: `list` leaves it out and `listInvalid` names it, so
 * a caller can report what it could not read. A rejected entry stays in the
 * outbox (`state: "rejected"`) instead of being deleted — the reason is the
 * record of why the provider refused it, and a later CLI may requeue it.
 *
 * Reads, directory creation and removal go through the mirror store's
 * filesystem seam, `_memoryStoreDeps`; the write path is `writeFileAtomic`, whose
 * own seam is `_atomicWriteDeps`. Temp names are never spelled here.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { NaxError } from "#src/infra/nax-error";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { byCodePoint, byNumber } from "#src/internal/sort";
import { parseMemoryNoteRecord } from "./note.ts";
import type { MemoryWriteRequest } from "./provider-types.ts";
import { _memoryStoreDeps } from "./store.ts";
import { MEMORY_CLIENT_ID_RE, MEMORY_FORGET_REASON_MAX_CHARS, MEMORY_SCOPES, memoryNoteKey } from "./types.ts";

const ERROR_STAGE = "memory";
/** An entry file's name: the sequence, the client id that keys it, then the suffix. */
const ENTRY_FILE_RE = /^(\d{8})-([A-Za-z0-9_-]+)\.json$/;
const ENTRY_SEQ_DIGITS = 8;
const ENTRY_SUFFIX = ".json";
/** A link at an entry name is not an entry this outbox wrote, so reads never follow one. */
const READ_FLAGS: number = constants.O_RDONLY | constants.O_NOFOLLOW;

/** The write the caller hands over: it owns the content, the outbox may own the id. */
type OutboxRequest = Omit<MemoryWriteRequest, "clientId"> & { clientId?: string };

/** One queued write as the outbox holds it: the request plus where it sits in the order. */
export type MemoryOutboxEntry = MemoryWriteRequest & {
  readonly seq: number;
  readonly enqueuedAt: string;
  readonly state: "queued" | "rejected";
  /** The rejection reason once rejected; the request's own reason until then. */
  readonly reason?: string;
  /** A reason the request itself carried (a forget's justification), kept across a rejection. */
  readonly requestReason?: string;
};

/** The durable queue of unacknowledged writes. */
export interface MemoryOutbox {
  enqueue(request: OutboxRequest): Promise<MemoryOutboxEntry>;
  list(): Promise<MemoryOutboxEntry[]>;
  listInvalid(): Promise<string[]>;
  remove(clientId: string): Promise<void>;
  markRejected(clientId: string, reason: string): Promise<void>;
  heldKeys(kind?: "save" | "forget"): Promise<ReadonlySet<string>>;
}

/** Every field an entry file has to carry to be replayed; the note is checked separately. */
const EntrySchema = z
  .object({
    kind: z.enum(["save", "forget"]),
    clientId: z.string().regex(MEMORY_CLIENT_ID_RE),
    scope: z.enum(MEMORY_SCOPES),
    slug: z.string().min(1),
    writeMode: z.enum(["direct", "proposal"]),
    note: z.unknown().optional(),
    reason: z.string().optional(),
    requestReason: z.string().optional(),
    seq: z.number().int().positive(),
    enqueuedAt: z.string().min(1),
    state: z.enum(["queued", "rejected"]),
  })
  .refine((entry) => entry.state !== "queued" || (entry.reason?.length ?? 0) <= MEMORY_FORGET_REASON_MAX_CHARS, {
    // A queued entry's `reason` is the forget's own justification, which `forgetMemoryNote`
    // caps. A rejected entry's is the provider's answer, kept as it arrived: bounding that
    // would turn a legitimately rejected write into an unreadable entry.
    message: `a queued reason must be at most ${MEMORY_FORGET_REASON_MAX_CHARS} characters`,
    path: ["reason"],
  });

/** One entry file: what its name says about it, before its content is read. */
interface EntryFile {
  readonly name: string;
  readonly seq: number;
  readonly clientId: string;
}

/** One sweep of the directory: the entries it holds, and the names it could not read. */
interface OutboxScan {
  readonly entries: MemoryOutboxEntry[];
  readonly invalid: string[];
}

/** A path that is not there: the outbox has no entries, rather than an error to report. */
function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function clientIdInvalid(clientId: string): NaxError {
  return new NaxError(`memory outbox client id "${clientId}" is not a valid client id`, "MEMORY_CLIENT_ID_INVALID", {
    stage: ERROR_STAGE,
    clientId,
  });
}

/** An entry's file name; the sequence is padded so a plain name sort is a sequence sort. */
function entryFileName(seq: number, clientId: string): string {
  return `${String(seq).padStart(ENTRY_SEQ_DIGITS, "0")}-${clientId}${ENTRY_SUFFIX}`;
}

/** The sequence and client id an entry file's name carries, or `null` when it is not one. */
function entryFileNamed(name: string): EntryFile | null {
  const match = ENTRY_FILE_RE.exec(name);
  if (match === null) return null;
  return { name, seq: Number(match[1]), clientId: match[2] };
}

/** Entries in sequence order, with equal sequences ordered by client id. */
function byEntryOrder(a: MemoryOutboxEntry, b: MemoryOutboxEntry): number {
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
function toEntry(text: string): MemoryOutboxEntry | null {
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
 * One entry as a rejection: `reason` carries the rejection, which is what the caller
 * reads to decide whether to requeue. The reason the request itself carried — a
 * forget's justification — is not lost to it; it moves to `requestReason`. Re-marking
 * an already rejected entry replaces the rejection reason and keeps the original.
 */
function toRejected(entry: MemoryOutboxEntry, rejectionReason: string): MemoryOutboxEntry {
  const { reason: currentReason, requestReason: keptReason, ...rest } = entry;
  const requestReason = keptReason ?? (entry.state === "queued" ? currentReason : undefined);
  return {
    ...rest,
    ...(requestReason === undefined ? {} : { requestReason }),
    state: "rejected",
    reason: rejectionReason,
  };
}

export function createMemoryOutbox(input: { readonly dir: string; readonly now?: () => Date }): MemoryOutbox {
  const { dir } = input;
  const now = input.now ?? (() => new Date());
  /** The tail of the enqueue chain: the one place a sequence is handed out. */
  let chain: Promise<void> = Promise.resolve();
  /** Every name in the directory, whatever it holds; a missing directory holds nothing. */
  async function entryNames(): Promise<string[]> {
    try {
      const dirents = await _memoryStoreDeps.readdir(dir, { withFileTypes: true });
      return dirents.map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }
  /** Every entry file in the directory, in name order: the only names this outbox reads. */
  async function entryFiles(): Promise<EntryFile[]> {
    return (await entryNames())
      .map((name) => entryFileNamed(name))
      .filter((file): file is EntryFile => file !== null)
      .sort((a, b) => byNumber(a.seq, b.seq) || byCodePoint(a.clientId, b.clientId));
  }
  /** One entry file's text; `null` when it cannot be read, which makes it an invalid entry. */
  async function readEntryText(path: string): Promise<string | null> {
    try {
      const file = await _memoryStoreDeps.open(path, READ_FLAGS);
      try {
        return await file.readText();
      } finally {
        await file.close();
      }
    } catch {
      // A file that vanished or cannot be read is not an entry the caller can act on.
      return null;
    }
  }
  /** One named file as an entry, or `null` when its content is not one. */
  async function readEntry(file: EntryFile): Promise<MemoryOutboxEntry | null> {
    const text = await readEntryText(join(dir, file.name));
    return text === null ? null : toEntry(text);
  }
  /** The whole directory: readable entries in sequence order, plus the names that are not. */
  async function scan(): Promise<OutboxScan> {
    const entries: MemoryOutboxEntry[] = [];
    const invalid: string[] = [];
    for (const file of await entryFiles()) {
      const entry = await readEntry(file);
      if (entry === null) invalid.push(file.name);
      else entries.push(entry);
    }
    entries.sort(byEntryOrder);
    return { entries, invalid };
  }
  /** The entry files naming one client id: found by name, so an unreadable entry is removable. */
  async function filesFor(clientId: string): Promise<EntryFile[]> {
    return (await entryFiles()).filter((file) => file.clientId === clientId);
  }

  /** The request with its client id settled: a supplied id is kept, a missing one is minted. */
  function withClientId(request: OutboxRequest): MemoryWriteRequest {
    const clientId = request.clientId ?? randomUUID();
    if (!MEMORY_CLIENT_ID_RE.test(clientId)) throw clientIdInvalid(clientId);
    return { ...request, clientId };
  }

  /** The highest sequence the directory already carries: 0 when it holds no entry. */
  async function highestSeq(): Promise<number> {
    const files = await entryFiles();
    return files.reduce((highest, file) => Math.max(highest, file.seq), 0);
  }

  /** Write one entry file, creating the directory only now that there is something to store. */
  async function writeEntry(request: MemoryWriteRequest): Promise<MemoryOutboxEntry> {
    const seq = (await highestSeq()) + 1;
    const entry: MemoryOutboxEntry = { ...request, seq, enqueuedAt: now().toISOString(), state: "queued" };
    await _memoryStoreDeps.mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, entryFileName(seq, request.clientId)), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  async function enqueue(request: OutboxRequest): Promise<MemoryOutboxEntry> {
    // The id is settled before joining the chain: a refused request must not delay the next one.
    const prepared = withClientId(request);
    const run = chain.then(() => writeEntry(prepared));
    // The chain never carries a rejection forward: one failed enqueue must not poison the next.
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  }

  async function list(): Promise<MemoryOutboxEntry[]> {
    return (await scan()).entries;
  }

  async function listInvalid(): Promise<string[]> {
    return (await scan()).invalid;
  }

  async function remove(clientId: string): Promise<void> {
    for (const file of await filesFor(clientId)) {
      await _memoryStoreDeps.rm(join(dir, file.name), { force: true });
    }
  }

  async function markRejected(clientId: string, reason: string): Promise<void> {
    for (const file of await filesFor(clientId)) {
      const entry = await readEntry(file);
      // An entry that cannot be read cannot be rewritten either; it stays for listInvalid.
      if (entry === null) continue;
      const rejected = toRejected(entry, reason);
      await writeFileAtomic(join(dir, file.name), `${JSON.stringify(rejected)}\n`);
    }
  }

  async function heldKeys(kind?: "save" | "forget"): Promise<ReadonlySet<string>> {
    const keys = new Set<string>();
    for (const entry of (await scan()).entries) {
      if (entry.state !== "queued") continue;
      if (kind !== undefined && entry.kind !== kind) continue;
      keys.add(memoryNoteKey(entry.scope, entry.slug));
    }
    return keys;
  }

  return { enqueue, list, listInvalid, remove, markRejected, heldKeys };
}
