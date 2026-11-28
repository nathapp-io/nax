/**
 * The outbox: the writes the agent has taken but a provider has not
 * acknowledged, held on disk until a sync delivers them.
 *
 * One JSON file per entry, `<seq padded to 8 digits>-<clientId>.json`, written
 * whole through `writeFileAtomic`: the bytes land in a sibling `.tmp` stage and
 * are renamed over the entry name, so a crash leaves either the old entry or
 * none, never a torn one, and a reader never sees a half-written file. `seq`
 * numbers the entries in the order they were taken. A promise chain orders this
 * instance's enqueues, and the shared file lock guards assignment across processes.
 * `list` still breaks a tie by client id for entries written by earlier versions.
 *
 * A file whose name matches the entry pattern but whose content is not an entry
 * is never silently dropped: `list` leaves it out and `listInvalid` names it, so
 * a caller can report what it could not read. A rejected entry stays in the
 * outbox (`state: "rejected"`) instead of being deleted — the reason is the
 * record of why the provider refused it, and a later CLI may requeue it.
 *
 * A third state is the same idea for a different failure: `state: "uncertain"` is a write that
 * was dispatched and never answered by a provider that declares it non-replayable. It may have
 * committed, so nothing sends it again and its key stays held — no later write of the same note
 * is dispatched on the guess that it failed. Its payload and the reason are kept for an
 * operator, and `requeue`/`discard` are the only ways out: the sync never touches it.
 *
 * Removal on a caller's decision follows the same rule as a read: the entry file
 * is the fact, never a caller's listing of it. `requeue` and `discard` run from
 * the CLI while a sync may be draining, so an entry a caller saw as rejected may
 * already be a queued write again; `removeIfRejected` claims the file by rename,
 * reads what it holds there, and puts a live entry back untouched.
 *
 * The one length rule an entry carries — a reason is at most
 * `MEMORY_FORGET_REASON_MAX_CHARS` — is enforced where an entry is *taken*
 * (`enqueue`), never where it is read. An entry that fails a read check does not
 * get reported: it leaves `list`, `heldKeys` and every count built on them, and
 * the write it holds is never replayed. A read check would therefore retire the
 * entries written before it existed, so the gate refuses the request instead, and
 * a reason that is already on disk still lists and still replays.
 *
 * Reads, directory creation and removal go through the mirror store's
 * filesystem seam, `_memoryStoreDeps`; the write path is `writeFileAtomic`, whose
 * own seam is `_atomicWriteDeps`. Temp names are never spelled here.
 *
 * One entry may name another in `awaits`: the client id it must not be delivered before. A
 * merge stages one save for the replacement it wrote and one forget per source it folded, and
 * the reconcile step (`sync-drain.ts`) is what enforces the order — the queue only records it.
 * The dependency is therefore bookkeeping, not content: it is validated when the entry is taken
 * (an id the queue could never hold is refused with the entry's own id check) and it is never
 * part of the request a provider is handed. The one place the queue acts on it is a discard: an
 * entry that leaves with writes waiting on it refuses them in the same lock
 * (`discardUndelivered`), because a dependency that simply vanished reads as a delivered one.
 *
 * Both decisions a caller makes from a listing — requeue (`allowDuplicate`) and discard — are
 * re-made here against the entry file, under the lock that guards every writer: a sync may have
 * turned a `rejected` entry `uncertain` since the caller read it, and that entry must not be sent
 * again without an acknowledgement nor released to the writes that wait on it.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { join } from "node:path";
import { NaxError } from "#src/infra/nax-error";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { withFileLock } from "#src/internal/file-lock";
import { byCodePoint, byNumber } from "#src/internal/sort";
import {
  byEntryOrder,
  type EntryFile,
  entryFileName,
  entryFileNamed,
  type MemoryOutboxEntry,
  toEntry,
  undelivered,
} from "./outbox-entry.ts";
import {
  discardEntry,
  type MemoryDiscardOutcome,
  type MemoryRequeueOptions,
  type MemoryRequeueOutcome,
  type OutboxEntryAccess,
  requeueEntry,
} from "./outbox-recovery.ts";
import type { MemoryWriteRequest } from "./provider-types.ts";
import { _memoryStoreDeps } from "./store.ts";
import { MEMORY_CLIENT_ID_RE, type MemoryWriteRefusal, memoryNoteKey } from "./types.ts";
import { forgetReasonRefusal } from "./validate.ts";

const ERROR_STAGE = "memory";
/**
 * The suffix a claimed entry file carries while its removal is being decided.
 *
 * It is appended after `.json`, so `ENTRY_FILE_RE` never matches a claimed name: the claim is
 * outside the entry namespace. Every operation first restores leftover claims under the same
 * lock that guards removal, so even a queued write claimed just before a crash stays discoverable.
 */
const CLAIM_SUFFIX = ".claim";
/** A link at an entry name is not an entry this outbox wrote, so reads never follow one. */
const READ_FLAGS: number = constants.O_RDONLY | constants.O_NOFOLLOW;

/** The write the caller hands over: it owns the content, the outbox may own the ids. */
type OutboxRequest = Omit<MemoryWriteRequest, "clientId"> & {
  clientId?: string;
  /** The client id of an entry this one must not be delivered before. */
  awaits?: string;
};

/** A request the outbox has settled: its client id is known and its dependency may be carried. */
type PreparedRequest = MemoryWriteRequest & { readonly awaits?: string };

/**
 * The entry shape and its codec live in `outbox-entry.ts`; the queue re-exports the one name its
 * callers import from here, so the module's public surface is unchanged.
 */
export type { MemoryOutboxEntry } from "./outbox-entry.ts";

/**
 * The operator's two decisions — requeue and discard — are declared and implemented in
 * `outbox-recovery.ts`, which runs under this queue's lock; their types are re-exported here so a
 * caller imports the queue's whole surface from one module.
 */
export type {
  MemoryDiscardOutcome,
  MemoryRequeueOptions,
  MemoryRequeueOutcome,
} from "./outbox-recovery.ts";

/** The durable queue of unacknowledged writes. */
export interface MemoryOutbox {
  /**
   * Take one write, stamped with its sequence. A request the queue cannot carry is refused
   * before any file is written: `MEMORY_WRITE_REFUSED` for a reason past
   * `MEMORY_FORGET_REASON_MAX_CHARS` (or empty, or spanning lines) and
   * `MEMORY_CLIENT_ID_INVALID` for an id that is not one — its own client id, or the id it
   * `awaits`.
   */
  enqueue(request: OutboxRequest): Promise<MemoryOutboxEntry>;
  list(): Promise<MemoryOutboxEntry[]>;
  listInvalid(): Promise<string[]>;
  remove(clientId: string): Promise<void>;
  /**
   * The entry the outbox holds under `clientId` right now, read from its file; `undefined` when
   * it holds none. A caller's `list` is a snapshot — this is the entry as it is at the call.
   */
  held(clientId: string): Promise<MemoryOutboxEntry | undefined>;
  /**
   * Remove an entry only while it still holds a **rejected** entry, answering whether it did.
   *
   * The entry file is claimed by rename and its content read there, so the entry that is
   * removed is the one that was checked: a `queued` entry (put back by `requeue` between a
   * caller's listing and this call) is renamed back untouched. Removing a requeued retry would
   * throw away a write nobody has delivered.
   *
   * An `uncertain` entry is never removed here: it is the operator's note, and only `requeue` or
   * `discard` may decide what becomes of it.
   */
  removeIfRejected(clientId: string): Promise<boolean>;
  /**
   * Drop an undelivered entry for good — `rejected`, or `uncertain` — and refuse the writes that
   * wait on it. This is what the operator's `discard` runs on: both states hold a write nothing
   * will send again, so both are the operator's to drop.
   *
   * The claim protocol is `removeIfRejected`'s, for the same reason: the entry file is claimed
   * by rename and read there, so the entry that is removed is the one that was checked, and a
   * `queued` entry (put back by `requeue` between a caller's listing and this call) is renamed
   * back untouched rather than thrown away as a write nobody delivered.
   *
   * The writes waiting on it are refused in the same lock, and so are the writes waiting on
   * those. Removing the entry leaves them with an id the outbox no longer holds, which a drain
   * reads as "delivered, there is nothing left to wait for" — the one reading the `awaits` link
   * exists to prevent, because the dropped write's delivery was never proven. A discard therefore
   * cancels its dependent retirements instead of releasing them, with the reason that names it.
   */
  discardUndelivered(clientId: string): Promise<MemoryDiscardOutcome>;
  /**
   * Mark an entry as one whose dispatch may have been committed: `MEMORY_OP_TIMEOUT_MS` fired on
   * a non-replayable write, or its provider failed it without an answer. The reason replaces
   * whatever the entry carried (the request's own reason moves to `requestReason`, as a rejection
   * does) and the payload is untouched.
   *
   * The entry is neither queued nor deleted on purpose. Queued would make the next sync send it
   * again — the duplicate this exists to prevent — and deleting it would throw away the operator's
   * note. It keeps its key too, so no later write of the same note is dispatched on the guess
   * that this one failed; `nax memory requeue` puts it back in the queue once a human decides the
   * duplicate risk is acceptable, and `nax memory discard` drops it.
   */
  markUncertain(clientId: string, reason: string): Promise<void>;
  markRejected(clientId: string, reason: string): Promise<void>;
  /**
   * Count one bad response against a queued entry and keep its message; answers the entry's new
   * count, or 0 when the outbox holds no readable entry under that id. Delivery removes the
   * entry, so a count never outlives a success.
   */
  recordBadResponse(clientId: string, error: string): Promise<number>;
  /**
   * Put an undelivered entry back in the queue as it was taken: its own reason restored, the
   * rejection (or the unknown-delivery hold) and any bad-response count dropped. A queued or
   * absent entry is left alone.
   *
   * The state is read here, inside the outbox lock, rather than taken from the caller's listing:
   * a sync may have marked the entry `uncertain` since that read, and requeueing such a write
   * sends one that may already have committed. Requeueing it takes `options.allowDuplicate` —
   * the operator saying the duplicate risk is theirs — and only then does the next sync send it.
   */
  requeue(clientId: string, options?: MemoryRequeueOptions): Promise<MemoryRequeueOutcome>;
  /**
   * The keys of the notes this queue still holds a delivery for — every entry that is not
   * `rejected`, an `uncertain` one included: its write has not been answered, so the local copy
   * is still the one no pull may overwrite.
   */
  heldKeys(kind?: "save" | "forget"): Promise<ReadonlySet<string>>;
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

/** The refusal a request the queue cannot carry is thrown as, in the store's own vocabulary. */
function writeRefused(refusal: MemoryWriteRefusal): NaxError {
  return new NaxError(refusal.reason, "MEMORY_WRITE_REFUSED", { stage: ERROR_STAGE, field: refusal.field });
}

/**
 * Refuse a request whose reason the queue could not carry, before any entry file exists.
 *
 * `forgetMemoryNote` already applies this rule to a forget, so this is the gate every caller
 * of the outbox passes rather than a second, weaker copy of it: a reason that is empty, holds
 * a line break or runs past `MEMORY_FORGET_REASON_MAX_CHARS` is refused here and nothing is
 * written. The bound belongs on this side — the write — because a bound applied on the read
 * side retires the entries that predate it: they leave `list` and `heldKeys` with no word,
 * and the writes they hold are never replayed.
 */
function assertReasonCarries(request: MemoryWriteRequest): void {
  if (request.reason === undefined) return;
  const refusal = forgetReasonRefusal(request.reason);
  if (refusal !== null) throw writeRefused(refusal);
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
  /**
   * Restore every unfinished removal, including unreadable entries, before exposing the queue.
   * The shared lock proves no current remover owns a claim. Recovery is itself one rename: a
   * crash leaves either the claim for the next recovery or the entry in its normal namespace.
   * A collision is not permission to overwrite either version; name it instead of losing bytes.
   */
  async function recoverClaims(): Promise<void> {
    const names = new Set(await entryNames());
    for (const name of names) {
      if (!name.endsWith(CLAIM_SUFFIX)) continue;
      const original = name.slice(0, -CLAIM_SUFFIX.length);
      if (entryFileNamed(original) === null) continue;
      if (names.has(original)) {
        throw new NaxError(
          "memory outbox claim conflicts with an existing entry; preserve both files for recovery",
          "MEMORY_OUTBOX_CLAIM_CONFLICT",
          {
            stage: ERROR_STAGE,
            entryPath: join(dir, original),
            claimPath: join(dir, name),
          },
        );
      }
      await _memoryStoreDeps.rename(join(dir, name), join(dir, original));
    }
  }

  /**
   * Snapshot reads stay nonblocking while an atomic write is staged. If a claim is visible,
   * join the removal lock before recovering it: it may still belong to a live remover.
   */
  async function reading<T>(operation: () => Promise<T>, empty: T): Promise<T> {
    const names = await entryNames();
    const hasClaim = names.some(
      (name) => name.endsWith(CLAIM_SUFFIX) && entryFileNamed(name.slice(0, -CLAIM_SUFFIX.length)) !== null,
    );
    return hasClaim ? locked(operation, empty) : operation();
  }

  /**
   * Writers and recovery share the removal lock, across instances and processes. Mutators of
   * an absent directory return their empty result without creating artifacts. Enqueue creates
   * the directory before entering; validation still happens before any I/O. Older versions
   * without this lock must not run against the same queue concurrently.
   */
  async function locked<T>(operation: () => Promise<T>, empty: T): Promise<T> {
    try {
      await _memoryStoreDeps.lstat(dir);
    } catch (error) {
      if (isMissing(error)) return empty;
      throw error;
    }
    return underLock(operation);
  }

  function underLock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(
      join(dir, ".outbox.lock"),
      async () => {
        await recoverClaims();
        return operation();
      },
      { lockName: "memory-outbox", errorPrefix: "[memory]" },
    );
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
  /** One path as an entry, or `null` when its content is not one. */
  async function readEntryAt(path: string): Promise<MemoryOutboxEntry | null> {
    const text = await readEntryText(path);
    return text === null ? null : toEntry(text);
  }
  /** One named file as an entry, or `null` when its content is not one. */
  async function readEntry(file: EntryFile): Promise<MemoryOutboxEntry | null> {
    return readEntryAt(join(dir, file.name));
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

  /** What the operator's two decisions read and write: entry files, one at a time, under the lock. */
  const recovery: OutboxEntryAccess = {
    files: entryFiles,
    filesFor,
    read: readEntry,
    write: (file, entry) => writeFileAtomic(join(dir, file.name), `${JSON.stringify(entry)}\n`),
  };

  /** The request with its ids settled: a supplied client id is kept, a missing one is minted. */
  function withClientId(request: OutboxRequest): PreparedRequest {
    const clientId = request.clientId ?? randomUUID();
    if (!MEMORY_CLIENT_ID_RE.test(clientId)) throw clientIdInvalid(clientId);
    // The awaited id names an entry of this same queue, so it is held to the same shape — and
    // refused before anything is written, exactly as the entry's own id is. A dependency the
    // queue could never hold would be a wait that never ends.
    if (request.awaits !== undefined && !MEMORY_CLIENT_ID_RE.test(request.awaits))
      throw clientIdInvalid(request.awaits);
    return { ...request, clientId };
  }

  /** The highest sequence the directory already carries: 0 when it holds no entry. */
  async function highestSeq(): Promise<number> {
    const files = await entryFiles();
    return files.reduce((highest, file) => Math.max(highest, file.seq), 0);
  }

  /** Write one entry file, creating the directory only now that there is something to store. */
  async function writeEntry(request: PreparedRequest): Promise<MemoryOutboxEntry> {
    const seq = (await highestSeq()) + 1;
    const entry: MemoryOutboxEntry = { ...request, seq, enqueuedAt: now().toISOString(), state: "queued" };
    await _memoryStoreDeps.mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, entryFileName(seq, request.clientId)), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  async function enqueue(request: OutboxRequest): Promise<MemoryOutboxEntry> {
    // The id and the reason are settled before joining the chain: a refused request must not
    // delay the next one, and a reason the queue cannot carry writes no entry at all.
    const prepared = withClientId(request);
    assertReasonCarries(prepared);
    const run = chain.then(async () => {
      await _memoryStoreDeps.mkdir(dir, { recursive: true });
      return underLock(() => writeEntry(prepared));
    });
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

  async function held(clientId: string): Promise<MemoryOutboxEntry | undefined> {
    for (const file of await filesFor(clientId)) {
      const entry = await readEntry(file);
      if (entry !== null) return entry;
    }
    return undefined;
  }

  /**
   * One entry file, removed only while the entry it holds is one `removable` accepts. Answers the
   * entry it removed — the bytes it claimed and read — or `null` when it removed nothing.
   *
   * The file is claimed by rename before it is read, because the read and the removal have to
   * see the same bytes: `requeue` in another process rewrites the entry in place, so a name
   * checked and then removed could take back the queued retry that landed in between. A claim
   * name is not an entry name (`entryFileNamed` refuses it), so nothing else can rewrite the
   * claim while it is held, and an entry the caller would not remove is renamed back
   * untouched. Losing the race the other way — the entry left before the claim — removes
   * nothing, which is what the caller asked for anyway. The outbox lock covers the whole claim
   * and every writer, so a requeue cannot rewrite the entry during this decision. A claim left
   * by a crash is restored under that same lock before the next reader or writer runs; the
   * removal was not committed until the claim was deleted, whatever state its bytes carry.
   */
  async function removeOneWhile(
    file: EntryFile,
    removable: (entry: MemoryOutboxEntry) => boolean,
  ): Promise<MemoryOutboxEntry | null> {
    const path = join(dir, file.name);
    const claim = join(dir, `${file.name}${CLAIM_SUFFIX}`);
    try {
      await _memoryStoreDeps.rename(path, claim);
    } catch (error) {
      // Gone between the listing and now: there is nothing left to remove.
      if (isMissing(error)) return null;
      throw error;
    }
    const claimed = await readEntryAt(claim);
    if (claimed === null || !removable(claimed)) {
      await _memoryStoreDeps.rename(claim, path);
      return null;
    }
    await _memoryStoreDeps.rm(claim, { force: true });
    return claimed;
  }

  async function removeIfRejected(clientId: string): Promise<boolean> {
    let removed = false;
    for (const file of await filesFor(clientId)) {
      if ((await removeOneWhile(file, (entry) => entry.state === "rejected")) !== null) removed = true;
    }
    return removed;
  }

  /** The operator's discard, over the claim protocol: only an undelivered entry leaves the queue. */
  function discardUndelivered(clientId: string): Promise<MemoryDiscardOutcome> {
    return discardEntry(recovery, clientId, (file) => removeOneWhile(file, (entry) => entry.state !== "queued"));
  }

  /**
   * Rewrite every readable entry file of `clientId` as `state` with `reason`.
   *
   * A file whose content is not an entry is left exactly as it is: `listInvalid` names it, and a
   * rewrite would invent content for it.
   */
  async function markEntry(clientId: string, state: "rejected" | "uncertain", reason: string): Promise<void> {
    for (const file of await filesFor(clientId)) {
      const entry = await readEntry(file);
      // An entry that cannot be read cannot be rewritten either; it stays for listInvalid.
      if (entry === null) continue;
      await writeFileAtomic(join(dir, file.name), `${JSON.stringify(undelivered(entry, state, reason))}\n`);
    }
  }

  async function markRejected(clientId: string, reason: string): Promise<void> {
    await markEntry(clientId, "rejected", reason);
  }

  async function markUncertain(clientId: string, reason: string): Promise<void> {
    await markEntry(clientId, "uncertain", reason);
  }

  async function recordBadResponse(clientId: string, error: string): Promise<number> {
    let count = 0;
    for (const file of await filesFor(clientId)) {
      const entry = await readEntry(file);
      // An entry that cannot be read cannot be rewritten either; it stays for listInvalid.
      if (entry === null) continue;
      count = (entry.badResponses ?? 0) + 1;
      const counted: MemoryOutboxEntry = { ...entry, badResponses: count, lastError: error };
      await writeFileAtomic(join(dir, file.name), `${JSON.stringify(counted)}\n`);
    }
    return count;
  }

  /** The operator's requeue, deciding from the entry file rather than from a caller's listing. */
  function requeue(clientId: string, allowDuplicate: boolean): Promise<MemoryRequeueOutcome> {
    return requeueEntry(recovery, clientId, allowDuplicate);
  }

  async function heldKeys(kind?: "save" | "forget"): Promise<ReadonlySet<string>> {
    const keys = new Set<string>();
    for (const entry of (await scan()).entries) {
      // Rejected is the one state with no delivery coming: its write will never be sent, so the
      // mirror's copy is not protected. An uncertain entry's write has no answer at all yet.
      if (entry.state === "rejected") continue;
      if (kind !== undefined && entry.kind !== kind) continue;
      keys.add(memoryNoteKey(entry.scope, entry.slug));
    }
    return keys;
  }

  return {
    enqueue,
    list: () => reading(list, []),
    listInvalid: () => reading(listInvalid, []),
    remove: (clientId) => locked(() => remove(clientId), undefined),
    held: (clientId) => reading(() => held(clientId), undefined),
    removeIfRejected: (clientId) => locked(() => removeIfRejected(clientId), false),
    discardUndelivered: (clientId) => locked(() => discardUndelivered(clientId), { discarded: false, refused: [] }),
    markRejected: (clientId, reason) => locked(() => markRejected(clientId, reason), undefined),
    markUncertain: (clientId, reason) => locked(() => markUncertain(clientId, reason), undefined),
    recordBadResponse: (clientId, error) => locked(() => recordBadResponse(clientId, error), 0),
    requeue: (clientId, options) => locked(() => requeue(clientId, options?.allowDuplicate === true), "unchanged"),
    heldKeys: (kind) => reading(() => heldKeys(kind), new Set<string>()),
  };
}
