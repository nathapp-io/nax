/**
 * host-forget-keys.ts — the notes a forget still holds, as one key set per mirror.
 *
 * A key is `"<scope>/<slug>"` and there are three sources, which are three different facts:
 *
 * - the outbox holds a queued forget the next sync will deliver;
 * - the mirror's own record (`pending-forgets.jsonl`) holds a proposal forget that was
 *   answered and recorded;
 * - the koda approvals file holds a forget koda answered with a `202` — an approval koda has
 *   opened and has not settled, so the note is still live and a later pull may still retire it.
 *
 * A key can be in one, two or all three. Read on every call, because a sync, an approval or a
 * pull's resolution retires them.
 *
 * The module lives beside `host.ts` rather than in it because the host is at its size cap, and
 * because the key spelling is the one thing the CLI's listing and the index's renderer must
 * agree on: both ask a host for this set and mark a row whose key is in it.
 *
 * Internal to `src/memory/`: the host composes it and re-exports `pendingForgetKey`. Both
 * index surfaces read koda's records through `kodaHeldForgetKeys` here — the store's
 * `heldForgets` source and the host's own key set — so a held note is marked the same way
 * wherever a row is rendered.
 */
import type { MemoryOutbox, MemoryScope, MemoryStore } from "@nathapp/nax-agent";
import type { KodaApprovals } from "./koda-approvals";

/** The parts of the host a pending-forget read needs: the queue, the record and koda's file. */
export interface ForgetKeyParts {
  /** The queue a forget is waiting in. */
  readonly outbox: Pick<MemoryOutbox, "heldKeys">;
  /** The mirror, for its own `pending-forgets.jsonl` record. */
  readonly store: Pick<MemoryStore, "readPendingForgets">;
  /** koda's approval records; only a koda-backed host composes one. */
  readonly kodaApprovals?: KodaApprovals;
}

/**
 * The key a pending forget is recorded by: `"<scope>/<slug>"`.
 *
 * nax-agent keys its own record with `memoryNoteKey`, which the package's entry does not
 * export; this is that one spelling, in one place, for both the host's key set and the
 * listing row that reads it.
 */
export function pendingForgetKey(about: { readonly scope: MemoryScope; readonly slug: string }): string {
  return `${about.scope}/${about.slug}`;
}

/**
 * The forget records koda's approvals file holds, as the index's key set.
 *
 * The one read both index surfaces use: the mirror store's `heldForgets` source and the
 * host's own `forgetPendingKeys` call it, so a note a koda forget is holding is marked
 * wherever a row is rendered. A host that composes no approvals record — a local- or
 * MCP-backed one — holds nothing, and a file that cannot be used reads as no records:
 * `list` never throws, because it writes nothing and so loses nothing, and a listing must
 * not fail because the file is unreadable.
 *
 * @param approvals - koda's proposal record, or the `undefined` of a host that has none
 */
export async function kodaHeldForgetKeys(approvals: KodaApprovals | undefined): Promise<ReadonlySet<string>> {
  const keys = new Set<string>();
  if (approvals === undefined) return keys;
  for (const record of await approvals.list()) {
    if (record.kind === "forget") keys.add(pendingForgetKey(record));
  }
  return keys;
}

/**
 * The notes a forget still holds: the queued ones, the mirror's recorded ones and koda's held
 * ones, as one set.
 */
export async function readForgetPendingKeys(parts: ForgetKeyParts): Promise<ReadonlySet<string>> {
  const [queued, recorded, held] = await Promise.all([
    parts.outbox.heldKeys("forget"),
    parts.store.readPendingForgets(),
    kodaHeldForgetKeys(parts.kodaApprovals),
  ]);
  if (recorded.length === 0 && held.size === 0) return queued;
  const keys = new Set(queued);
  for (const entry of recorded) keys.add(pendingForgetKey(entry));
  for (const key of held) keys.add(key);
  return keys;
}
