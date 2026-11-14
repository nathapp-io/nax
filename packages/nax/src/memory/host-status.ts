/**
 * host-status.ts — what a host reports about itself without answering one of its reads.
 *
 * The status is a composition of its own: the mirror's and the repository's counts, the
 * outbox's, whatever the last sync left in `sync.json`, and — for a koda-backed host alone —
 * the proposals koda refused. It lives beside `host.ts` rather than in it because that file
 * is at its size cap; the move is behaviour-neutral and the caller still asks the host.
 *
 * Two facts keep it a read. The write mode is koda's answer for the calling agent, never
 * `memory.writeMode`, which the provider ignores — but asking would make a status that hangs
 * or fails exactly when the user is checking why a sync does not work, so the status says
 * koda decides rather than asking. And the refusal report is read from the file the pull
 * wrote; nothing here writes it, so a status can never turn a fact into a new one.
 *
 * Every type it needs comes from `host.ts` type-only: those imports are erased, so this leaf
 * cannot join an initialisation cycle with the module that calls it.
 *
 * Internal to `src/memory/`: the host answers `status` with it.
 */
import type { MemoryOutboxEntry } from "@nathapp/nax-agent";
import type { HostInput, HostReads, MemoryStatus } from "./host";
import { MEMORY_KODA_PROVIDER_PREFIX } from "./koda-provider";
import type { MemoryKodaRefusal } from "./koda-refusals";

/** An outbox entry the provider refused, or a sync parked: what it was and why it stopped. */
export interface MemoryRejectedEntry {
  readonly kind: MemoryOutboxEntry["kind"];
  readonly scope: MemoryOutboxEntry["scope"];
  readonly slug: string;
  readonly reason: string;
}

/** The rejected entries as the status reports them; an entry with no reason says so. */
function rejectedEntries(entries: readonly MemoryOutboxEntry[]): MemoryRejectedEntry[] {
  return entries
    .filter((entry) => entry.state === "rejected")
    .map(({ kind, scope, slug, reason }) => ({ kind, scope, slug, reason: reason ?? "no reason recorded" }));
}

/** How many outbox entries are in one state: still to deliver, or refused by the provider. */
function countState(entries: readonly MemoryOutboxEntry[], state: "queued" | "rejected"): number {
  return entries.filter((entry) => entry.state === state).length;
}

/**
 * The write mode the status reports.
 *
 * With the koda provider the mode is koda's answer for the calling agent (`GET .../memory/write-mode`),
 * never `memory.writeMode`, which the provider ignores. Status stays an offline read, so it says
 * koda decides rather than asking: a status that needs the network would hang or fail exactly when
 * the user is checking why a sync does not work.
 */
function statusWriteMode(input: HostInput): MemoryStatus["writeMode"] {
  return input.parts.provider.id.startsWith(MEMORY_KODA_PROVIDER_PREFIX) ? "koda" : input.config.writeMode;
}

/** One logged refusal as the status names it: the log's entry less koda's approval id. */
function reportedRefusal(entry: MemoryKodaRefusal): MemoryKodaRefusal {
  return { kind: entry.kind, scope: entry.scope, slug: entry.slug, status: entry.status, refusedAt: entry.refusedAt };
}

/**
 * The proposals koda refused, or `undefined` for a host that composes no refusal report.
 *
 * `undefined` rather than `[]` on purpose: a local- or MCP-backed host has no refusals to
 * report, and an empty list would say it had looked and found none.
 */
async function kodaRefusalsOf(input: HostInput): Promise<readonly MemoryKodaRefusal[] | undefined> {
  if (input.parts.kodaRefusals === undefined) return undefined;
  return (await input.parts.kodaRefusals.list()).map(reportedRefusal);
}

/**
 * What the surfaces report about a host without calling one of its reads.
 *
 * The note counts are the mirror's own — a repo note is the repository's, and is
 * counted once by `repo` if the mirror's notes do not shadow it. `lastPullAt` and
 * `lastError` are whatever the last sync left in `sync.json`.
 */
export async function readStatus(reads: HostReads, input: HostInput): Promise<MemoryStatus> {
  const [project, user, entries, sync, kodaRefusals] = await Promise.all([
    reads.projectScope(),
    reads.mirrorNotes("user"),
    input.parts.outbox.list(),
    input.parts.store.readSyncState(),
    kodaRefusalsOf(input),
  ]);
  return {
    enabled: true,
    provider: input.parts.provider.id,
    writeMode: statusWriteMode(input),
    projectDir: input.parts.dirs.projectDir,
    userDir: input.parts.dirs.userDir,
    lastPullAt: sync.lastPullAt,
    lastError: sync.lastError,
    queued: countState(entries, "queued"),
    rejected: countState(entries, "rejected"),
    rejectedEntries: rejectedEntries(entries),
    ...(kodaRefusals === undefined ? {} : { kodaRefusals }),
    notes: { project: project.mirror.length, user: user.length, repo: project.unshadowed.length },
    repoSkipped: project.skipped,
  };
}
