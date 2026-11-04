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
 * Intent is persisted outside the mirror. After the config changes, the old mirror is atomically
 * renamed into quarantine. A detached record is persisted BEFORE recursive quarantine deletion.
 * Empty or absent mirrors get an empty quarantine file instead, atomically placed by rename.
 * Until that record lands, quarantine must remain present: its existence proves detachment already
 * happened even if the process stopped between rename and record update. Once detached, retries
 * only delete quarantine, never the live mirror, even when it has since been rebuilt.
 * Records from older versions without a phase are refused: their mirror generation is ambiguous.
 */
import { basename, dirname, join } from "node:path";
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
  readonly phase: "attached" | "detached";
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
  readonly phase: PendingRelink["phase"];
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

/** The old generation is moved here atomically, outside the live mirror namespace. */
export function relinkQuarantinePath(dirs: Pick<MemoryDirs, "root" | "projectDir">): string {
  return `${pendingRelinkPath(dirs)}.mirror`;
}

/** Unlike listing the tree itself, listing its parent distinguishes absent and empty trees. */
async function quarantineExists(dirs: MemoryDirs): Promise<boolean> {
  const path = relinkQuarantinePath(dirs);
  return (await _memoryAdminDeps.listDir(dirname(path))).includes(basename(path));
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
  const phase = stringField(parsed, "phase");
  return project === undefined || from === undefined || (phase !== "attached" && phase !== "detached")
    ? undefined
    : { project, from, phase };
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
  const text = `${JSON.stringify(relink, null, 2)}\n`;
  try {
    await _memoryAdminDeps.writeText(tmpPath, text);
    await _memoryAdminDeps.rename(tmpPath, path);
  } catch (cause) {
    throw new NaxError(
      `${STAGE_LABEL}cannot record the relink in ${path}: ${errorMessage(cause)}`,
      "MEMORY_RELINK_RECORD_FAILED",
      { stage: STAGE, path, cause },
    );
  }
}

/** Drop an abandoned intent, cleaning only its quarantined generation, never the live mirror. */
export async function dropPendingRelink(dirs: MemoryDirs): Promise<void> {
  if (await quarantineExists(dirs)) await _memoryAdminDeps.removePath(relinkQuarantinePath(dirs));
  await _memoryAdminDeps.removePath(pendingRelinkPath(dirs));
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

/** An atomic detach failure leaves the old tree intact; undo its config change if possible. */
async function undoFailedDetach(job: RelinkJob, cause: unknown): Promise<NaxError> {
  try {
    await restoreProjectConfig(job.configPath, job.previousConfig);
    return relinkRolledBack(job, cause);
  } catch (undoCause) {
    return relinkUnrecovered(job, cause, undoCause);
  }
}

/** Detach exactly the old generation. Never delete quarantine before persisting that fact. */
async function detachProjectMirror(job: RelinkJob): Promise<void> {
  if (!(await quarantineExists(job.dirs))) {
    const quarantine = relinkQuarantinePath(job.dirs);
    try {
      if (await mirrorHasContent(job.dirs)) {
        await _memoryAdminDeps.rename(job.dirs.projectDir, quarantine);
      } else {
        // Even "nothing to detach" needs evidence if phase persistence fails before a rebuild.
        // Stage outside quarantine so a failed write cannot leave false detachment evidence.
        const tmpPath = `${quarantine}${RECORD_TMP_SUFFIX}`;
        await _memoryAdminDeps.writeText(tmpPath, "");
        await _memoryAdminDeps.rename(tmpPath, quarantine);
      }
    } catch (cause) {
      throw await undoFailedDetach(job, cause);
    }
  }
  await writePendingRelink(job.dirs, { project: job.slug, from: job.from, phase: "detached" });
}

/** Discard only the detached generation; failures leave both it and the record retryable. */
async function discardQuarantine(job: RelinkJob): Promise<void> {
  const path = relinkQuarantinePath(job.dirs);
  if (!(await quarantineExists(job.dirs))) return;
  try {
    await _memoryAdminDeps.removePath(path);
  } catch (cause) {
    throw new NaxError(
      `${STAGE_LABEL}cannot discard quarantined mirror ${path}: ${errorMessage(cause)}; ` +
        `run \`nax memory link ${job.slug}\` again to finish cleanup`,
      "MEMORY_RELINK_CLEANUP_FAILED",
      { stage: STAGE, path, cause },
    );
  }
}

/** A detached retry can only remove the old quarantine, never a rebuilt live mirror. */
export async function finishRelink(job: RelinkJob): Promise<void> {
  if (job.phase === "attached") await detachProjectMirror(job);
  await discardQuarantine(job);
  const record = pendingRelinkPath(job.dirs);
  try {
    await _memoryAdminDeps.removePath(record);
  } catch (cause) {
    throw new NaxError(
      `${STAGE_LABEL}the project mirror ${job.dirs.projectDir} was discarded, but ${record} could not be ` +
        `removed: ${errorMessage(cause)}; run \`nax memory link ${job.slug}\` again to finish cleanup`,
      "MEMORY_RELINK_RECORD_STUCK",
      { stage: STAGE, projectDir: job.dirs.projectDir, path: record, cause },
    );
  }
}
