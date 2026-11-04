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
 * So the intent is persisted **before** the config changes. `<projectDir>/relink-pending.json`
 * records the project being linked and the one it replaces; it lives inside the mirror, so a
 * discard that succeeds takes it with them and no separate cleanup can fail. A run that finds a
 * record for the project it is linking is finishing an earlier relink: it discards (after the
 * same undelivered-writes check) instead of comparing project slugs. A record for any other
 * project is one whose config write never landed, so the mirror still belongs to the project the
 * config names and must not be discarded — it is left in place and overwritten by the next relink.
 *
 * The undo of the config write is attempted first, because it puts the repository back the way it
 * was and leaves the retry a genuine relink; the record is what covers the case where the undo
 * itself fails. Both arms are reported with the mirror path, the record path and the command to
 * run again.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { restoreProjectConfig, stringField } from "./memory-admin-config";
import { _memoryAdminDeps, linkRefusal, STAGE, STAGE_LABEL } from "./memory-admin-deps";

/** The record's file name inside a project's mirror. */
const RELINK_MARKER_FILE = "relink-pending.json";
/** The file the record is staged in before the rename puts it in place. */
const MARKER_TMP_SUFFIX = ".tmp";

/** What an unfinished relink recorded: the project being linked, and the one it replaces. */
export interface PendingRelink {
  readonly project: string;
  readonly from: string;
}

/** The mirror owed a discard, and the config write that preceded it. */
export interface RelinkJob {
  /** The project mirror to discard: the host's `dirs.projectDir`. */
  readonly projectDir: string;
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

/** The record's path inside a project's mirror. */
export function pendingRelinkPath(projectDir: string): string {
  return join(projectDir, RELINK_MARKER_FILE);
}

/** The record a mirror holds, or `undefined` when it holds none. */
export async function readPendingRelink(projectDir: string): Promise<PendingRelink | undefined> {
  const path = pendingRelinkPath(projectDir);
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
export async function writePendingRelink(projectDir: string, relink: PendingRelink): Promise<void> {
  const path = pendingRelinkPath(projectDir);
  const tmpPath = `${path}${MARKER_TMP_SUFFIX}`;
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

/** The failure a discarded mirror is reported as when the config write could be undone. */
function relinkRolledBack(job: RelinkJob, cause: unknown): NaxError {
  return new NaxError(
    `${STAGE_LABEL}cannot discard the project mirror ${job.projectDir}: ${errorMessage(cause)}; ` +
      `${job.slug} is still recorded as relinking from "${job.from}" in ${pendingRelinkPath(job.projectDir)}, ` +
      `so run \`nax memory link ${job.slug}\` again to finish it`,
    "MEMORY_RELINK_ROLLED_BACK",
    { stage: STAGE, projectDir: job.projectDir, path: pendingRelinkPath(job.projectDir), cause },
  );
}

/** The failure a discarded mirror is reported as when the config write could not be undone. */
function relinkUnrecovered(job: RelinkJob, cause: unknown, undoCause: unknown): NaxError {
  return new NaxError(
    `${STAGE_LABEL}cannot discard the project mirror ${job.projectDir}: ${errorMessage(cause)}, and cannot ` +
      `restore ${job.configPath}: ${errorMessage(undoCause)}; the relink to "${job.slug}" is still recorded in ` +
      `${pendingRelinkPath(job.projectDir)}, so run \`nax memory link ${job.slug}\` again (or remove ` +
      `${job.projectDir}) before the next sync`,
    "MEMORY_RELINK_UNRECOVERED",
    { stage: STAGE, projectDir: job.projectDir, path: job.configPath, cause, undoCause },
  );
}

/**
 * The error a failed discard is reported as, after undoing the config write it followed.
 *
 * The undo puts the repository back the way it was, so the retry reads the previous project as
 * the one being replaced and discards again. When the undo fails too, the record written before
 * the config changed is what the retry reads instead — which is why the record exists.
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
export async function discardProjectMirror(job: RelinkJob): Promise<void> {
  try {
    await _memoryAdminDeps.removePath(job.projectDir);
  } catch (cause) {
    throw await undoFailedDiscard(job, cause);
  }
}
