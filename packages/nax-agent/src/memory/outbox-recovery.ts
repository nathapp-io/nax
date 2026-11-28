/**
 * The two decisions an operator makes about an undelivered entry: put it back in the queue, or
 * drop it for good. They live apart from `outbox.ts` because the queue's mechanics — the lock, the
 * sequence chain, the claim-by-rename removal — are one subject, and what an operator may decide
 * about a write nothing will deliver is another.
 *
 * Both decisions are re-made here against the entry file rather than taken from the listing the
 * caller read. `nax memory requeue` and `nax memory discard` run from the CLI while a sync may be
 * draining the same queue, so a `rejected` entry a caller listed can be an `uncertain` one by the
 * time its write lands: the same file, a different fact about it.
 *
 * The rules themselves are the feature's, not this module's:
 *
 * - An `uncertain` write was dispatched and never answered by a provider that may not repeat it,
 *   so requeueing it sends something that may already exist. Only an explicit acknowledgement
 *   (`allowDuplicate`) does that; without one the entry is left exactly as it was.
 * - A discard drops the entry, which leaves the writes waiting on it (`awaits`) naming an id the
 *   queue no longer holds — and a drain reads a vanished dependency as a delivered replacement.
 *   Their replacement's delivery was never proven, so they are refused instead, in the same lock,
 *   with the reason that names what took it away. The chain is walked as well: a refused
 *   retirement can itself be waited on.
 *
 * Everything here runs inside the outbox's lock, over the `OutboxEntryAccess` the queue hands it.
 */
import { type EntryFile, type MemoryOutboxEntry, toQueued, undelivered } from "./outbox-entry.ts";

/**
 * What a `requeue` did with the entry it was given.
 *
 * `requeued` — the write is in the queue again and the next sync will send it.
 * `held` — the entry is `uncertain` and the caller did not accept the duplicate risk, so it is
 * left exactly as it was.
 * `unchanged` — the outbox holds nothing under that id, or already had it queued.
 */
export type MemoryRequeueOutcome = "requeued" | "held" | "unchanged";

/** What a requeue takes beyond the entry: the operator's acceptance of the duplicate risk. */
export interface MemoryRequeueOptions {
  /**
   * Requeue an `uncertain` entry, whose dispatch may already have committed. Without it such an
   * entry is left in place: sending it again may create a second copy on the provider.
   */
  readonly allowDuplicate?: boolean;
}

/**
 * What a `discardEntry` did.
 *
 * `discarded` says whether the entry left the queue, and `refused` names the writes that waited
 * on it — and the writes that waited on those — now marked `rejected`, because the replacement
 * they were folded into is not known to have been delivered.
 */
export interface MemoryDiscardOutcome {
  readonly discarded: boolean;
  readonly refused: readonly MemoryOutboxEntry[];
}

/** What these decisions read and write: entry files, one at a time, under the outbox's lock. */
export interface OutboxEntryAccess {
  /** Every entry file in the directory, in sequence order. */
  readonly files: () => Promise<readonly EntryFile[]>;
  /** The entry files naming one client id. */
  readonly filesFor: (clientId: string) => Promise<readonly EntryFile[]>;
  /** One file's entry, or `null` when its content is not one. */
  readonly read: (file: EntryFile) => Promise<MemoryOutboxEntry | null>;
  /** Rewrite one file as `entry`. */
  readonly write: (file: EntryFile, entry: MemoryOutboxEntry) => Promise<void>;
}

/**
 * Why a write that waited on a discarded entry is refused, in the words a drain uses for the same
 * refusal (`refuseUnsent` in `sync-drain.ts`): the replacement it was folded into is not known to
 * be on the provider, so its source is not the provider's to lose.
 */
function waitsOnDiscarded(slug: string): string {
  return `not sent: the replacement it waits on (${slug}) was discarded`;
}

/**
 * Put each entry file of `clientId` back in the queue, deciding from the file it holds.
 *
 * A queued entry is already going to be delivered, so it is left alone and does not count as
 * moved. An `uncertain` one is the case `allowDuplicate` exists for: `held` says it stayed put.
 */
export async function requeueEntry(
  access: OutboxEntryAccess,
  clientId: string,
  allowDuplicate: boolean,
): Promise<MemoryRequeueOutcome> {
  let requeued = false;
  let held = false;
  for (const file of await access.filesFor(clientId)) {
    const entry = await access.read(file);
    if (entry === null || entry.state === "queued") continue;
    if (entry.state === "uncertain" && !allowDuplicate) {
      held = true;
      continue;
    }
    await access.write(file, toQueued(entry));
    requeued = true;
  }
  if (requeued) return "requeued";
  return held ? "held" : "unchanged";
}

/** Walk the waiter graph under the writer lock. A rejected link may be from a partial discard. */
async function refuseWaiters(access: OutboxEntryAccess, target: MemoryOutboxEntry): Promise<MemoryOutboxEntry[]> {
  const waiters = new Map<string, { file: EntryFile; entry: MemoryOutboxEntry }[]>();
  for (const file of await access.files()) {
    const entry = await access.read(file);
    if (entry?.awaits === undefined || entry.state === "uncertain") continue;
    const siblings = waiters.get(entry.awaits) ?? [];
    siblings.push({ file, entry });
    waiters.set(entry.awaits, siblings);
  }

  const refused: MemoryOutboxEntry[] = [];
  const pending = [target];
  for (const dependency of pending) {
    const children = waiters.get(dependency.clientId) ?? [];
    // Consume each set of edges only once, even when the links form a cycle.
    waiters.delete(dependency.clientId);
    for (const { entry, file } of children) {
      if (entry.state === "queued") {
        const refusal = undelivered(entry, "rejected", waitsOnDiscarded(dependency.slug));
        await access.write(file, refusal);
        refused.push(refusal);
      } else if (entry.reason === waitsOnDiscarded(dependency.slug)) {
        // A failed attempt returned no outcome. Report its durable refusals on retry too,
        // without rewriting them, so callers rewind every affected scope.
        refused.push(entry);
      }
      pending.push(entry);
    }
  }
  return refused;
}

/** Refuse dependents only after validating the claim, but before committing its removal. */
export async function discardEntry(
  access: OutboxEntryAccess,
  clientId: string,
  removeOne: (
    file: EntryFile,
    beforeRemoval: (claimed: MemoryOutboxEntry) => Promise<void>,
  ) => Promise<MemoryOutboxEntry | null>,
): Promise<MemoryDiscardOutcome> {
  const refused: MemoryOutboxEntry[] = [];
  let discarded = false;
  for (const file of await access.filesFor(clientId)) {
    const removed = await removeOne(file, async (claimed) => {
      for (const entry of await refuseWaiters(access, claimed)) refused.push(entry);
    });
    if (removed !== null) discarded = true;
  }
  return { discarded, refused };
}
