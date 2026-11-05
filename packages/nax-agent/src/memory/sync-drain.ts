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
 * Split from `sync.ts`, which owns the lock, the probe, the pull and the run's result.
 */

import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { applyPushed } from "./delivery.ts";
import { isMemoryBadResponse, isMemoryPushRejected } from "./note.ts";
import type { MemoryOutbox, MemoryOutboxEntry } from "./outbox.ts";
import type { MemoryProvider, MemoryPushResult, MemoryWriteRequest } from "./provider-types.ts";
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
async function pushEntry(
  input: MemoryDrainInput,
  entry: MemoryOutboxEntry,
  timers: MemoryTimers,
): Promise<PushOutcome> {
  try {
    const pushed = input.provider.push(requestOf(entry));
    return { kind: "pushed", result: await raceTimeout(pushed, MEMORY_OP_TIMEOUT_MS, timers) };
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
 * Apply one answered push: a refusal is kept on the entry with its reason, a delivery is
 * mirrored and removed. Answers the tally with the entry counted.
 */
async function settle(
  input: MemoryDrainInput,
  entry: MemoryOutboxEntry,
  outcome: AnsweredOutcome,
  tally: DrainTally,
): Promise<DrainTally> {
  if (outcome.kind === "rejected") {
    await input.outbox.markRejected(entry.clientId, outcome.reason);
    return { ...tally, rejected: tally.rejected + 1 };
  }
  await applyPushed(input, entry, outcome.result);
  await input.outbox.remove(entry.clientId);
  return { ...tally, pushed: tally.pushed + 1 };
}

/**
 * Step 3: deliver every queued write, oldest first.
 *
 * `list()` answers with the rejected entries too — they are the record of a refusal —
 * so only `queued` entries are pushed: nothing here retries a permanent one. An entry a
 * proof already delivered (see `proveAndPark`) is not pushed a second time.
 */
export async function drainOutbox(input: MemoryDrainInput): Promise<DrainResult> {
  const timers = input.timers ?? GLOBAL_MEMORY_TIMERS;
  const queue = (await input.outbox.list()).filter((entry) => entry.state === "queued");
  const proven = new Set<string>();
  let tally: DrainTally = { pushed: 0, rejected: 0, parked: [] };
  for (const [index, entry] of queue.entries()) {
    if (proven.has(entry.clientId)) continue;
    const outcome = await pushEntry(input, entry, timers);
    if (outcome.kind !== "failed") {
      tally = await settle(input, entry, outcome, tally);
      continue;
    }
    const proof = outcome.badResponse
      ? await proveAndPark(input, { head: entry, rest: queue.slice(index + 1), error: outcome.reason, timers }, tally)
      : null;
    if (proof === null)
      return { ...tally, failure: outcome.reason, ...(outcome.badResponse ? { answered: true } : {}) };
    proven.add(proof.clientId);
    tally = proof.tally;
  }
  return tally;
}

/** What `proveAndPark` looks at: the entry that failed, the queue behind it, and why it failed. */
interface ParkCandidate {
  readonly head: MemoryOutboxEntry;
  readonly rest: readonly MemoryOutboxEntry[];
  readonly error: string;
  readonly timers: MemoryTimers;
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
 * badly) and nothing is parked; the proof's own failure is not counted against it.
 */
async function proveAndPark(
  input: MemoryDrainInput,
  candidate: ParkCandidate,
  tally: DrainTally,
): Promise<{ readonly clientId: string; readonly tally: DrainTally } | null> {
  const { head, rest, error, timers } = candidate;
  const count = await input.outbox.recordBadResponse(head.clientId, error);
  if (count < MEMORY_PUSH_MAX_BAD_RESPONSES) return null;
  const proof = rest.find((entry) => entryKey(entry) !== entryKey(head));
  if (proof === undefined) return null;
  const outcome = await pushEntry(input, proof, timers);
  if (outcome.kind === "failed") return null;
  const settled = await settle(input, proof, outcome, tally);
  const parked = await park(input, head, `parked after ${count} bad responses: ${error}`);
  return {
    clientId: proof.clientId,
    tally: { ...settled, rejected: settled.rejected + 1, parked: [...settled.parked, parked] },
  };
}

/** Mark `entry` rejected with `reason`, warning once: a parked forget leaves its note live on the provider. */
async function park(input: MemoryDrainInput, entry: MemoryOutboxEntry, reason: string): Promise<MemoryParkedEntry> {
  await input.outbox.markRejected(entry.clientId, reason);
  const { clientId, kind, scope, slug } = entry;
  warnQuietly(input.logger, "memory sync parked an outbox entry the provider keeps answering badly", {
    clientId,
    kind,
    scope,
    slug,
    error: reason,
  });
  return { clientId, kind, scope, slug, reason };
}
