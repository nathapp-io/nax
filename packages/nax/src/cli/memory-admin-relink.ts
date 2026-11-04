/**
 * The mirror transition a relink makes: the record it leaves first, the discard it finishes with,
 * and what is left when the discard cannot be finished.
 *
 * A relink is two writes that must both land — the project config names a new project, and the
 * mirror that still holds the previous project's notes and export cursor is discarded — and only
 * the first of them can be undone reliably. A failed discard therefore has two outcomes, and a
 * warning is not enough for either: the next `nax memory link` must know that a discard is owed,
 * or it will read the new slug as "already linked", skip the cleanup and report a success that
 * never happened, leaving the old cursor to be decoded in the new project.
 *
 * So the intent is persisted **before** the config changes, and it is persisted **outside the
 * tree the discard deletes**. `removePath` is recursive: it deletes as it walks, so a directory
 * that cannot be removed completely is still partly gone, and a record inside it could be one of
 * the entries that go before the failure. `<root>/relink/<project>.json` — a sibling namespace of
 * `<root>/projects/` — cannot be touched by any discard of a mirror, so the record survives
 * exactly the failure it exists for. It is removed only once the discard has finished.
 *
 * A run that finds a record for the project it is linking is finishing an earlier relink: it
 * discards (when the mirror is still there to discard) after the same undelivered-writes check.
 * A record for any other project is one whose config write never landed, so the mirror still
 * belongs to the project the config names; it is dropped rather than acted on. A record that
 * cannot be read is refused, because a durable fact this command cannot interpret is not one to
 * guess at with a mirror at stake.
 */
import { basename, join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { MemoryDirs } from "@/memory";
import { restoreProjectConfig, stringField } from "./memory-admin-config";
import { _memoryAdminDeps, linkRefusal, STAGE, STAGE_LABEL } from "./memory-admin-deps";

/** The directory under the memory root that holds the relink records. */
const RELINK_DIR_NAME = "relink";
/** The file the record is staged in before the rename puts it in place. */
const RECORD_TMP_SUFFIX = ".tmp";

/** What an unfinished relink recorded: the project being linked, and the one it replaces. */
export interface PendingRelink {
  readonly project: string;
  readonly from: string;
}

/** The mirror owed a discard, and the config write that preceded it. */
export interface RelinkJob {
  /** The mirror directories the host resolved: the mirror itself, and the root beside it. */
  readonly dirs: MemoryDirs;
  /** The project config the link rewrites, put back when the discard fails. */
  readonly configPath: string;
  /** The project the mirror still belongs to. */
  readonly from: string;
  /** The project being linked, which the config will name (or already names). */
  readonly slug: string;
  /** The exact text the project config held before this run rewrote it. */
  readonly previousConfig: string | null;
  /** True when an earlier run already recorded this relink. */
  readonly recorded: boolean;
}

/**
 * The record's path: a sibling namespace of the mirrors, never inside one.
 *
 * Keyed by the mirror's own directory name (`<segment>-<hash8>`), which is unique per repository,
 * so two repositories never share a record and removing one mirror cannot reach another's.
 */
export function pendingRelinkPath(dirs: Pick<MemoryDirs, "root" | "projectDir">): string {
  return join(dirs.root, RELINK_DIR_NAME, `${basename(dirs.projectDir)}.json`);
}

/** The record a mirror holds, or `undefined` when it holds none. */
export async function readPendingRelink(dirs: MemoryDirs): Promise<PendingRelink | undefined> {
  const path = pendingRelinkPath(dirs);
  const text = await _memoryAdminDeps.readText(path);
  if (text === null) return undefined;
  const relink = parsePendingRelink(text);
  if (relink === undefined) {
    throw linkRefusal(`cannot read the pending relink in ${path}: it is not a relink record`, { path });
  }
  return relink;
}

/** The record `text` holds, or `undefined` when it is not one this module wrote. */
function parsePendingRelink(text: string): PendingRelink | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the caller refuses rather than guessing what a relink it cannot read owed.
    return undefined;
  }
  const project = stringField(parsed, "project");
  const from = stringField(parsed, "from");
  return project === undefined || from === undefined ? undefined : { project, from };
}

/**
 * Record a relink before the config it changes, so a retry can finish it.
 *
 * Staged through a temporary file and a rename like the config itself: a torn record would be
 * unreadable, and an unreadable record is the one state this module refuses rather than guesses.
 */
export async function writePendingRelink(dirs: MemoryDirs, relink: PendingRelink): Promise<void> {
  const path = pendingRelinkPath(dirs);
  const tmpPath = `${path}${RECORD_TMP_SUFFIX}`;
  const text = `${JSON.stringify({ project: relink.project, from: relink.from }, null, 2)}\n`;
  try {
    await _memoryAdminDeps.writeText(tmpPath, text);
    await _memoryAdminDeps.rename(tmpPath, path);
  } catch (cause) {
    throw new NaxError(
      `${STAGE_LABEL}cannot record the relink in ${path}: ${errorMessage(cause)}; nothing was changed`,
      "MEMORY_RELINK_RECORD_FAILED",
      { stage: STAGE, path, cause },
    );
  }
}

/**
 * Drop a record nothing is owed for, best effort.
 *
 * Only a record from a relink whose config write never landed is dropped this way. Leaving it
 * would be harmless — it is dropped again next time — so a filesystem that will not remove it is
 * not worth failing a link the operator asked for.
 */
export async function dropPendingRelink(dirs: MemoryDirs): Promise<void> {
  await _memoryAdminDeps.removePath(pendingRelinkPath(dirs)).catch(() => {});
}

/** Whether the mirror still holds anything: a tree with no entries has nothing to discard. */
export async function mirrorHasContent(dirs: Pick<MemoryDirs, "projectDir">): Promise<boolean> {
  return (await _memoryAdminDeps.listDir(dirs.projectDir)).length > 0;
}

/** The failure a discarded mirror is reported as when the config write could be undone. */
function relinkRolledBack(job: RelinkJob, cause: unknown): NaxError {
  return new NaxError(
    `${STAGE_LABEL}cannot discard the project mirror ${job.dirs.projectDir}: ${errorMessage(cause)}; ` +
      `${job.slug} is still recorded as relinking from "${job.from}" in ${pendingRelinkPath(job.dirs)}, ` +
      `so run \`nax memory link ${job.slug}\` again to finish it`,
    "MEMORY_RELINK_ROLLED_BACK",
    { stage: STAGE, projectDir: job.dirs.projectDir, path: pendingRelinkPath(job.dirs), cause },
  );
}

/** The failure a discarded mirror is reported as when the config write could not be undone. */
function relinkUnrecovered(job: RelinkJob, cause: unknown, undoCause: unknown): NaxError {
  const record = pendingRelinkPath(job.dirs);
  return new NaxError(
    `${STAGE_LABEL}cannot discard the project mirror ${job.dirs.projectDir}: ${errorMessage(cause)}, and ` +
      `cannot restore ${job.configPath}: ${errorMessage(undoCause)}; the relink to "${job.slug}" is still ` +
      `recorded in ${record}, so run \`nax memory link ${job.slug}\` again (or remove ` +
      `${job.dirs.projectDir}) before the next sync`,
    "MEMORY_RELINK_UNRECOVERED",
    { stage: STAGE, projectDir: job.dirs.projectDir, path: job.configPath, cause, undoCause },
  );
}

/**
 * The error a failed discard is reported as, after undoing the config write it followed.
 *
 * The undo puts the repository back the way it was, so the retry reads the previous project as
 * the one being replaced and discards again. When the undo fails too, the record written before
 * the config changed is what the retry reads instead — which is why the record exists, and why it
 * is stored outside the tree the failed discard half-deleted.
 */
async function undoFailedDiscard(job: RelinkJob, cause: unknown): Promise<NaxError> {
  try {
    await restoreProjectConfig(job.configPath, job.previousConfig);
    return relinkRolledBack(job, cause);
  } catch (undoCause) {
    return relinkUnrecovered(job, cause, undoCause);
  }
}

/** Discard the previous project's mirror, undoing the config write when it cannot be discarded. */
async function discardProjectMirror(job: RelinkJob): Promise<void> {
  try {
    await _memoryAdminDeps.removePath(job.dirs.projectDir);
  } catch (cause) {
    throw await undoFailedDiscard(job, cause);
  }
}

/**
 * Finish a recorded relink: discard the mirror if it is still there, then clear the record.
 *
 * The record goes last, and only after the discard has succeeded, so an interruption anywhere
 * leaves either the record (a later run finishes) or nothing at all (nothing is owed). A record
 * that cannot be removed is reported rather than swallowed: it claims a discard is owed, and a
 * later run would act on that claim against a mirror this project has since rebuilt.
 */
export async function finishRelink(job: RelinkJob): Promise<void> {
  if (await mirrorHasContent(job.dirs)) await discardProjectMirror(job);
  const record = pendingRelinkPath(job.dirs);
  try {
    await _memoryAdminDeps.removePath(record);
  } catch (cause) {
    throw new NaxError(
      `${STAGE_LABEL}the project mirror ${job.dirs.projectDir} was discarded, but ${record} could not be ` +
        `removed: ${errorMessage(cause)}; remove it before the next link`,
      "MEMORY_RELINK_RECORD_STUCK",
      { stage: STAGE, projectDir: job.dirs.projectDir, path: record, cause },
    );
  }
}
