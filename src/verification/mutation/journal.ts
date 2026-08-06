/**
 * In-flight mutant journal — crash-durable record of an applied mutation.
 *
 * The spot-check reverts in a `finally`, which covers a thrown error but not
 * process death. If the run is interrupted between apply and revert (Ctrl+C,
 * SIGKILL, a crash, a lost machine), deliberately-broken source is left in the
 * user's worktree with nothing but a log line to say so.
 *
 * An on-disk journal is what survives that: it is written BEFORE the mutation
 * and deleted only after a verified revert, so its mere existence at the start
 * of a later run means "a mutation was applied and never confirmed restored".
 * An in-process handler cannot make that guarantee — SIGKILL runs no handler.
 *
 * One file per story, so parallel stories never contend for the same journal.
 */

import { join, resolve, sep } from "node:path";
import { revertMutant } from "./apply";
import type { Mutant } from "./types";

const JOURNAL_DIRNAME = join(".nax", "mutation-journal");

/** Journalled mutant plus the story that applied it. */
export interface MutationJournalEntry extends Mutant {
  readonly storyId: string;
}

/** Result of restoring one journalled entry. */
export interface JournalRestoreResult {
  readonly entry: MutationJournalEntry;
  /** `restored` — the mutation was on disk and has been undone.
   *  `already-clean` — the line already held the original; nothing to do.
   *  `unrecoverable` — the line holds neither; left untouched. */
  readonly outcome: "restored" | "already-clean" | "unrecoverable";
  /** What the line actually held when the outcome is `unrecoverable`. */
  readonly actual?: string | null;
}

export function journalDir(repoRoot: string): string {
  return join(repoRoot, JOURNAL_DIRNAME);
}

/** Story ids reach the filesystem as names — keep them to a safe alphabet. */
function journalFileName(storyId: string): string {
  const safe = storyId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe || "unknown"}.json`;
}

export function journalPathFor(repoRoot: string, storyId: string): string {
  return join(journalDir(repoRoot), journalFileName(storyId));
}

/**
 * Record a mutant as in-flight. MUST be awaited before the mutation is
 * written, otherwise a crash in between leaves an unjournalled mutation.
 */
export async function recordInFlight(repoRoot: string, entry: MutationJournalEntry): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(journalDir(repoRoot), { recursive: true });
  await Bun.write(journalPathFor(repoRoot, entry.storyId), JSON.stringify(entry));
}

/** Drop a story's journal. Call only after a revert is confirmed. */
export async function clearInFlight(repoRoot: string, storyId: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  await unlink(journalPathFor(repoRoot, storyId)).catch(() => {});
}

async function readEntry(path: string): Promise<MutationJournalEntry | null> {
  try {
    const parsed = (await Bun.file(path).json()) as Partial<MutationJournalEntry>;
    if (
      typeof parsed?.storyId !== "string" ||
      typeof parsed?.file !== "string" ||
      typeof parsed?.line !== "number" ||
      typeof parsed?.before !== "string" ||
      typeof parsed?.after !== "string" ||
      typeof parsed?.operatorId !== "string"
    ) {
      return null;
    }
    return parsed as MutationJournalEntry;
  } catch {
    return null;
  }
}

/** Is `filePath` inside `root`'s subtree? */
function isInside(root: string, filePath: string): boolean {
  const base = resolve(root);
  const target = resolve(filePath);
  return target === base || target.startsWith(`${base}${sep}`);
}

/**
 * Restore every journalled mutation left behind by an earlier run, then clear
 * the journal.
 *
 * Entries naming a file OUTSIDE `repoRoot` are skipped and their journal is
 * left in place: they belong to a different working tree, and writing into one
 * we were not asked to touch is worse than the leftover we are cleaning up.
 * With a per-worktree anchor this should never trigger — it is the guard that
 * keeps a wrong anchor from becoming cross-tree corruption.
 *
 * The journal is cleared even for an `unrecoverable` entry: a line holding
 * neither the mutant nor the original has been rewritten by someone else, so
 * there is nothing left for us to undo and re-reporting it on every subsequent
 * run would be noise. The caller is expected to log that case loudly — the log
 * is the durable record at that point, not the journal.
 *
 * Fail-open: an unreadable journal directory or entry yields no results rather
 * than an error. Leftover cleanup must never be what breaks a run.
 */
export async function restoreInFlight(repoRoot: string): Promise<JournalRestoreResult[]> {
  const { readdir, unlink } = await import("node:fs/promises");
  const dir = journalDir(repoRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const results: JournalRestoreResult[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const entry = await readEntry(path);
    if (!entry) {
      await unlink(path).catch(() => {});
      continue;
    }
    if (!isInside(repoRoot, entry.file)) continue;
    results.push(await restoreEntry(entry));
    await unlink(path).catch(() => {});
  }
  return results;
}

async function restoreEntry(entry: MutationJournalEntry): Promise<JournalRestoreResult> {
  try {
    const result = await revertMutant(entry);
    if (result.reverted) return { entry, outcome: "restored" };
    if (result.reason === "content-mismatch" && result.actual === entry.before) {
      return { entry, outcome: "already-clean" };
    }
    return { entry, outcome: "unrecoverable", actual: result.actual };
  } catch {
    // The file is gone or unreadable — nothing to restore, nothing to break.
    return { entry, outcome: "unrecoverable", actual: null };
  }
}
