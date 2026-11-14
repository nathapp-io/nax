/**
 * The shared memory formatters: the one place a memory fact becomes text.
 *
 * Two surfaces print these lines — `/memory` in chat and the `nax memory` group — so the
 * shapes live here rather than at either of them: a status block of one `label: value`
 * line per fact, the one line a sync ends with, and the row a listed note becomes.
 *
 * Two lines are conditional, because an empty line says less than no line: `last error`
 * appears only when the last sync left one, and `repo notes skipped` only when a repository
 * note was rejected. `last sync` is never dropped — `never` is a fact, and its absence would
 * read as "unknown". `refused by koda` lines appear only when the host reported refusals,
 * one per entry after the `rejected:` lines: the outbox refused a write, koda refused a
 * proposal, and the two are different facts.
 *
 * Formatting is pure and total: nothing here reads a host, and no input makes it throw.
 */
import type { MemoryNote, MemorySyncResult } from "@nathapp/nax-agent";
import type { MemoryRejectedEntry, MemoryStatus } from "./host";
import type { MemoryKodaRefusal } from "./koda-refusals";

/**
 * A note as a listing row is printed: the six fields the line names. A whole `MemoryNote`
 * satisfies it, and so does a listing entry that carries no body.
 */
export type MemoryNoteLine = Pick<MemoryNote, "scope" | "slug" | "type" | "description" | "status" | "source">;

/** The status block, followed by the index when one is given: one blank line between them. */
export function formatMemoryStatus(status: MemoryStatus, index?: string): string {
  const lines = [
    `provider: ${status.provider}`,
    `write mode: ${status.writeMode === "koda" ? "decided by koda" : status.writeMode}`,
    `mirror: ${status.projectDir}`,
    `user notes: ${status.userDir}`,
    `last sync: ${status.lastPullAt ?? "never"}`,
    ...(status.lastError === null ? [] : [`last error: ${status.lastError}`]),
    `outbox: ${status.queued} queued, ${status.rejected} rejected`,
    ...status.rejectedEntries.map((entry) => `rejected: ${entryLabel(entry)} (${entry.reason})`),
    ...(status.kodaRefusals ?? []).map((entry) => `refused by koda: ${refusalLabel(entry)}`),
    `notes: ${status.notes.project} project, ${status.notes.user} user, ${status.notes.repo} repo`,
    ...(status.repoSkipped > 0 ? [`repo notes skipped: ${status.repoSkipped}`] : []),
  ];
  const block = lines.join("\n");
  return index === undefined ? block : `${block}\n\n${index}`;
}

/**
 * What one sync did: one line, then one more per entry the run parked.
 *
 * `failed` names the message the run ended with; the field is optional on the result, so a
 * failure that carried none says `unknown error` rather than printing an empty tail.
 */
export function formatMemorySyncResult(result: MemorySyncResult): string {
  const parked = (result.parked ?? []).map((entry) => `memory sync: parked ${entryLabel(entry)} (${entry.reason})`);
  return [syncOutcomeLine(result), ...parked].join("\n");
}

/** An outbox entry as the status and the sync line name it: `<kind> <scope>/<slug>`. */
function entryLabel(entry: Pick<MemoryRejectedEntry, "kind" | "scope" | "slug">): string {
  return `${entry.kind} ${entry.scope}/${entry.slug}`;
}

/** A refused proposal as the status names it: the write, the note, koda's word and when it came. */
function refusalLabel(entry: MemoryKodaRefusal): string {
  return `${entryLabel(entry)} (${entry.status}, ${entry.refusedAt})`;
}

/** The run's own line, before any parked entry is named. */
function syncOutcomeLine(result: MemorySyncResult): string {
  switch (result.outcome) {
    case "synced":
      return `memory sync: synced (pushed ${result.pushed}, rejected ${result.rejected}, pulled ${result.pulled}, skipped ${result.skipped})`;
    case "unreachable":
      return "memory sync: unreachable";
    case "locked":
      return "memory sync: locked";
    case "failed":
      return `memory sync: failed: ${result.error ?? "unknown error"}`;
  }
}

/** One listed note: `<scope>/<slug> [<type>] <description> (<status>; <source>)`. */
export function formatMemoryNoteLine(note: MemoryNoteLine): string {
  return `${note.scope}/${note.slug} [${note.type}] ${note.description} (${note.status}; ${note.source})`;
}
