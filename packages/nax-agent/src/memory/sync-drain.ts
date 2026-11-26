/**
 * Step 3 of a sync: drain the outbox, oldest first.
 *
 * Each `queued` entry is pushed in `seq` order through the operation race, and the provider's
 * answer is applied to the mirror before the entry is removed. `MEMORY_PUSH_REJECTED` is
 * permanent: the entry is marked with the reason and the drain continues. Anything else is
 * transient and stops the drain at that entry, so nothing overtakes it.
 *
 * One transient kind repeats: a bad response (`isMemoryBadResponse`), an answer that arrived
 * but cannot be used. It is counted on the entry, and an entry that meets
 * `MEMORY_PUSH_MAX_BAD_RESPONSES` of them is parked as `rejected` — but only once the next
 * write for a different key is answered, which proves the fault is the entry's and not the
 * provider's (#2793). A contract mismatch answers every write badly and parks nothing.
 *
 * An entry may also name the entry it waits on (`awaits`), which is how a merge's source
 * retirement is held behind the save of the replacement it was folded into. The drain reads the
 * outbox's current state of that id when it reaches the entry: refused, the entry is refused
 * with it and never pushed, and the scope's pull goes back to the beginning (a rejected entry
 * holds no key, so the provider's still-live source is the mirror's only copy); still queued,
 * the entry waits — not pushed, not counted, and the drain carries on; gone, there is nothing
 * to wait for and it is pushed as any other. A write that waits on a held entry is never used
 * as a proof either: its answer says nothing about the entry it is waiting on.
 *
 * Split from `sync.ts`, which owns the lock, the probe, the pull and the run's result.
 */

import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { applyPushed } from "./delivery.ts";
import { isMemoryBadResponse, isMemoryPushRejected } from "./note.ts";
import type { MemoryOutbox, MemoryOutboxEntry } from "./outbox.ts";
import type { MemoryProvider, MemoryPushResult, MemoryWriteRequest } from "./provider-types.ts";
import { rewindPullCursor } from "./pull-cursor.ts";
import type { MemoryStore } from "./store.ts";
import { GLOBAL_MEMORY_TIMERS, raceTimeout, warnQuietly } from "./support.ts";
import { MEMORY_OP_TIMEOUT_MS, MEMORY_PUSH_MAX_BAD_RESPONSES, type MemoryScope, type MemoryTimers } from "./types.ts";

/** What a drain reads and writes: the mirror, the queue, the provider and where warnings go. */
export interface MemoryDrainInput {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProvider;
  readonly logger: AgentLogger;
  /** The timer seam the push race runs against; default the globals. */
  readonly timers?: MemoryTimers;
}

/** An entry this run parked as `rejected` after it kept meeting bad responses. */
export interface MemoryParkedEntry {
  readonly clientId: string;
  readonly kind: MemoryOutboxEntry["kind"];
  readonly scope: MemoryScope;
  readonly slug: string;
  /** The rejection reason the entry now carries: the count and the last bad response. */
  readonly reason: string;
}

/**
 * The write an entry stands for, as the provider takes it.
 *
 * The entry carries the queue's own bookkeeping — its sequence, when it was taken,
 * whether it is still queued — and none of that is the provider's to read, so the
 * request is projected from the fields the two shapes share rather than forwarded.
 */
function requestOf(entry: MemoryOutboxEntry): MemoryWriteRequest {
  return {
    kind: entry.kind,
    clientId: entry.clientId,
    scope: entry.scope,
    slug: entry.slug,
    writeMode: entry.writeMode,
    ...(entry.note === undefined ? {} : { note: entry.note }),
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  };
}

/**
 * What one push came to: the provider's answer, a permanent refusal, or a transient failure —
 * `badResponse` saying whether that failure is the kind that repeats.
 */
type PushOutcome =
  | { readonly kind: "pushed"; readonly result: MemoryPushResult }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string; readonly badResponse: boolean };

/**
 * One entry, pushed through the operation race.
 *
 * `MEMORY_PUSH_REJECTED` is the provider saying it will never accept this write, so
 * it is separated here from every other throw and from the `MEMORY_TIMEOUT` the race
 * raises: only the first is worth keeping on the entry, and only the others are worth
 * another attempt.
 */
async function pushEntry(run: DrainRun, entry: MemoryOutboxEntry): Promise<PushOutcome> {
  try {
    const pushed = run.input.provider.push(requestOf(entry));
    return { kind: "pushed", result: await raceTimeout(pushed, MEMORY_OP_TIMEOUT_MS, run.timers) };
  } catch (error) {
    const reason = errorMessage(error);
    if (isMemoryPushRejected(error)) return { kind: "rejected", reason };
    return { kind: "failed", reason, badResponse: isMemoryBadResponse(error) };
  }
}

/** What a drain delivered, and the transient failure that stopped it early. */
export interface DrainResult {
  readonly pushed: number;
  readonly rejected: number;
  readonly parked: readonly MemoryParkedEntry[];
  /** The message of the failure that ended the drain; absent when every entry was delivered. */
  readonly failure?: string;
  /**
   * Whether the failure was a bad response: the provider answered, just not usably. Absent for
   * an outage. A sync still pulls after an answered failure, never after an outage.
   */
  readonly answered?: boolean;
}

/** What a drain has moved so far: the counters and the entries it parked. */
interface DrainTally {
  readonly pushed: number;
  readonly rejected: number;
  readonly parked: readonly MemoryParkedEntry[];
}

/** An outcome the provider answered: delivered, or refused for good. */
type AnsweredOutcome = Exclude<PushOutcome, { readonly kind: "failed" }>;

/** The key two writes share when one must not overtake the other. */
function entryKey(entry: MemoryOutboxEntry): string {
  return `${entry.scope}/${entry.slug}`;
}

/**
 * The outbox as one drain knows it: the list it read once, kept current as the run settles
 * entries.
 *
 * A merge queues one save and one forget per source, and every one of those forgets asks the
 * outbox the same question when the drain reaches it — "do you still hold the entry I wait on,
 * and what became of it?" Answering from the list the drain already read makes the question free
 * instead of a fresh read and parse of the whole outbox per forget. The view is kept truthful by
 * the run itself: every entry this drain refuses, removes or supersedes is recorded here as it
 * happens, so a write that waits on one of them still sees what the drain just did to it.
 */
interface OutboxView {
  /** The entry held under `clientId`, as this run has left it. */
  held(clientId: string): MemoryOutboxEntry | undefined;
  /** The rejected entries of `key` this run has not removed — the ones a delivery supersedes. */
  rejected(key: string): readonly MemoryOutboxEntry[];
  /** Record `entry` as refused, so a later entry that waits on it sees the refusal. */
  refused(entry: MemoryOutboxEntry, reason: string): void;
  /** Record that `clientId` has left the outbox. */
  removed(clientId: string): void;
}

function outboxView(entries: readonly MemoryOutboxEntry[]): OutboxView {
  const held = new Map<string, MemoryOutboxEntry>();
  for (const entry of entries) held.set(entry.clientId, entry);
  return {
    held: (clientId) => held.get(clientId),
    rejected: (key) => [...held.values()].filter((entry) => entry.state === "rejected" && entryKey(entry) === key),
    refused: (entry, reason) => {
      held.set(entry.clientId, { ...entry, state: "rejected", reason });
    },
    removed: (clientId) => {
      held.delete(clientId);
    },
  };
}

/** One drain's state, carried from entry to entry: what it reads and writes, and the queue as it is now. */
interface DrainRun {
  readonly input: MemoryDrainInput;
  readonly outbox: OutboxView;
  readonly timers: MemoryTimers;
}

/** Whether `entry` waits on an id the outbox still holds: such an entry is never a proof. */
function waitsOnHeld(entry: MemoryOutboxEntry, outbox: OutboxView): boolean {
  return entry.awaits !== undefined && outbox.held(entry.awaits) !== undefined;
}

/** What the entry an `awaiting` one names means for it right now. */
type AwaitsOutcome =
  | { readonly kind: "free" }
  | { readonly kind: "waiting" }
  | { readonly kind: "refused"; readonly slug: string };

/**
 * Whether `entry` may be pushed now, must wait, or has been refused along with its dependency.
 *
 * The question is answered against the outbox as it is *now*, not against the queue this drain
 * read at the start: an entry refused a moment ago in this very drain is a refusal the write
 * behind it must see, which is why the run records its own changes in the view. An id the outbox
 * no longer holds — delivered, or dropped as superseded — is not a reason to wait, because
 * nothing can arrive under it any more.
 */
function awaitsOutcome(run: DrainRun, entry: MemoryOutboxEntry): AwaitsOutcome {
  const awaitedId = entry.awaits;
  if (awaitedId === undefined) return { kind: "free" };
  const awaited = run.outbox.held(awaitedId);
  if (awaited === undefined) return { kind: "free" };
  if (awaited.state === "rejected") return { kind: "refused", slug: awaited.slug };
  return { kind: "waiting" };
}

/**
 * Mark `entry` rejected without ever pushing it, because the write it waits on was refused.
 *
 * A rejected entry holds no key, so the note this entry never delivered is still the provider's
 * to keep: the scope's pull goes back to the beginning and the next sync writes it back into
 * the mirror in full, exactly as `park` does for an entry the provider keeps answering badly.
 */
async function refuseUnsent(
  run: DrainRun,
  entry: MemoryOutboxEntry,
  awaitedSlug: string,
  tally: DrainTally,
): Promise<DrainTally> {
  const { input } = run;
  const reason = `not sent: the replacement it waits on (${awaitedSlug}) was refused`;
  await input.outbox.markRejected(entry.clientId, reason);
  run.outbox.refused(entry, reason);
  await rewindPullCursor(input.store, entry.scope);
  warnQuietly(input.logger, "memory sync refused an outbox entry whose replacement was refused", {
    clientId: entry.clientId,
    kind: entry.kind,
    scope: entry.scope,
    slug: entry.slug,
    awaits: entry.awaits,
    reason,
  });
  return { ...tally, rejected: tally.rejected + 1 };
}

/**
 * Apply one answered push: a refusal is kept on the entry with its reason, a delivery is
 * mirrored and removed. Answers the tally with the entry counted.
 *
 * A delivery also retires every older rejected write of the same note: the newer write is now
 * the provider's, so the older one is superseded, and requeueing it would replay stale content
 * over it (a forget would delete what was just saved).
 */
async function settle(
  run: DrainRun,
  entry: MemoryOutboxEntry,
  outcome: AnsweredOutcome,
  tally: DrainTally,
): Promise<DrainTally> {
  const { outbox } = run.input;
  if (outcome.kind === "rejected") {
    await outbox.markRejected(entry.clientId, outcome.reason);
    run.outbox.refused(entry, outcome.reason);
    return { ...tally, rejected: tally.rejected + 1 };
  }
  await applyPushed(run.input, entry, outcome.result);
  await outbox.remove(entry.clientId);
  run.outbox.removed(entry.clientId);
  await dropSuperseded(run, entry);
  return { ...tally, pushed: tally.pushed + 1 };
}

/** Remove the rejected writes of `delivered`'s note that were taken before it. */
async function dropSuperseded(run: DrainRun, delivered: MemoryOutboxEntry): Promise<void> {
  for (const entry of run.outbox.rejected(entryKey(delivered))) {
    if (entry.seq >= delivered.seq) continue;
    await run.input.outbox.remove(entry.clientId);
    run.outbox.removed(entry.clientId);
  }
}

/**
 * Start this scope's next pull from the beginning.
 *
 * Re-exported from the leaf module that owns it: `delivery.ts` needs the same rewind for a
 * `direct` forget the provider held pending, and importing it back from here would close a
 * cycle, because this file imports `applyPushed` from there. Every importer of `rewindPullCursor`
 * keeps this specifier.
 */
export { rewindPullCursor };

/**
 * Step 3: deliver every queued write, oldest first.
 *
 * `list()` answers with the rejected entries too — they are the record of a refusal —
 * so only `queued` entries are pushed: nothing here retries a permanent one. An entry a
 * proof already delivered (see `proveAndPark`) is not pushed a second time. An entry that
 * waits on another (`awaits`) is asked about first, and a refused dependency refuses it.
 */
export async function drainOutbox(input: MemoryDrainInput): Promise<DrainResult> {
  const all = await input.outbox.list();
  const run: DrainRun = { input, outbox: outboxView(all), timers: input.timers ?? GLOBAL_MEMORY_TIMERS };
  const queue = all.filter((entry) => entry.state === "queued");
  const proven = new Set<string>();
  let tally: DrainTally = { pushed: 0, rejected: 0, parked: [] };
  for (const [index, entry] of queue.entries()) {
    if (proven.has(entry.clientId)) continue;
    const waits = awaitsOutcome(run, entry);
    // A write still waiting on another one is neither sent nor counted: it is queued work the
    // order has not reached, and the entry it waits on is somewhere on this same queue.
    if (waits.kind === "waiting") continue;
    if (waits.kind === "refused") {
      tally = await refuseUnsent(run, entry, waits.slug, tally);
      continue;
    }
    const outcome = await pushEntry(run, entry);
    if (outcome.kind !== "failed") {
      tally = await settle(run, entry, outcome, tally);
      continue;
    }
    const candidate = { head: entry, rest: queue.slice(index + 1), proven, error: outcome.reason };
    const proof: ProofOutcome = outcome.badResponse
      ? await proveAndPark(run, candidate, tally)
      : { kind: "stopped", answered: false };
    if (proof.kind === "stopped")
      return { ...tally, failure: outcome.reason, ...(proof.answered ? { answered: true } : {}) };
    proven.add(proof.clientId);
    tally = proof.tally;
  }
  return tally;
}

/** What `proveAndPark` looks at: the entry that failed, the queue behind it, and why it failed. */
interface ParkCandidate {
  readonly head: MemoryOutboxEntry;
  readonly rest: readonly MemoryOutboxEntry[];
  /** Entries an earlier proof this run already delivered: never a proof a second time. */
  readonly proven: ReadonlySet<string>;
  readonly error: string;
}

/**
 * Count one bad response against the head entry, and park it once the fault is shown to be its own.
 *
 * Under `MEMORY_PUSH_MAX_BAD_RESPONSES` the answer is `null`, and the drain stops at the entry
 * as for any transient failure. At the limit the next queued write for a *different* key is
 * pushed as the proof: writes of the head's own key stay behind it, so per-key order holds.
 * When the provider answers that write — delivered or refused — the bad response is the head's
 * alone, so it is parked as `rejected` and the drain carries on. When the proof fails too, or
 * there is none to try, the failure is the provider's (a contract mismatch answers every write
 * badly) and nothing is parked; the proof's own failure is not counted against it. A proof that
 * fails on an outage makes the stop an outage too, so the sync does not pull after it.
 */
async function proveAndPark(run: DrainRun, candidate: ParkCandidate, tally: DrainTally): Promise<ProofOutcome> {
  const { head, rest, proven, error } = candidate;
  const count = await run.input.outbox.recordBadResponse(head.clientId, error);
  if (count < MEMORY_PUSH_MAX_BAD_RESPONSES) return { kind: "stopped", answered: true };
  // A write that waits on an entry the outbox still holds is not a proof: the head's fault
  // cannot be read from an answer to work whose own fate is not settled yet.
  const proof = rest.find(
    (entry) => !proven.has(entry.clientId) && entryKey(entry) !== entryKey(head) && !waitsOnHeld(entry, run.outbox),
  );
  if (proof === undefined) return { kind: "stopped", answered: true };
  const outcome = await pushEntry(run, proof);
  if (outcome.kind === "failed") return { kind: "stopped", answered: outcome.badResponse };
  const settled = await settle(run, proof, outcome, tally);
  const parked = await park(run, head, `parked after ${count} bad responses: ${error}`);
  return {
    kind: "parked",
    clientId: proof.clientId,
    tally: { ...settled, rejected: settled.rejected + 1, parked: [...settled.parked, parked] },
  };
}

/** What a proof came to: the head parked behind a delivered proof, or the drain stopped. */
type ProofOutcome =
  | { readonly kind: "parked"; readonly clientId: string; readonly tally: DrainTally }
  | { readonly kind: "stopped"; readonly answered: boolean };

/** Mark `entry` rejected with `reason`, warning once: a parked forget leaves its note live on the provider. */
async function park(run: DrainRun, entry: MemoryOutboxEntry, reason: string): Promise<MemoryParkedEntry> {
  await run.input.outbox.markRejected(entry.clientId, reason);
  run.outbox.refused(entry, reason);
  await rewindPullCursor(run.input.store, entry.scope);
  const { clientId, kind, scope, slug } = entry;
  warnQuietly(run.input.logger, "memory sync parked an outbox entry the provider keeps answering badly", {
    clientId,
    kind,
    scope,
    slug,
    error: reason,
  });
  return { clientId, kind, scope, slug, reason };
}
