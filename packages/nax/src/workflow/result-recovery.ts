/**
 * `<runDir>/result.recovery.json` (#2984): the good bytes of a `result.json` that a run-end or crash
 * repair could not restore because another process held the feature's handoff lock. The repair writes
 * this file beside the result it could not fix; whoever next takes that lock applies it when the
 * result still holds the recorded damage, and discards it when a newer write has replaced the result.
 *
 * Nothing here follows a link. Only an entry that `lstat`s as a real directory is a run directory, so a
 * link, a `.handoff.lock` file or anything else in the workflow directory is skipped (as `listRunDirs`
 * in `handoff-record.ts` skips it) and nothing is written through one. The recovery file and the result
 * are opened read-only, never through a link and never blocking, and the opened handle must be a regular
 * file before a byte is read: a FIFO in either place would otherwise stall the replay — and with it the
 * handoff lock and that lock holder's own task — until some writer appeared. A result this module cannot
 * read as a plain file is a per-run failure that keeps the recovery file, never a reason to overwrite or
 * discard it; a recovery file it cannot read is left exactly where it is and reported `unreadable`,
 * because a file it cannot trust must never overwrite a result. Every other failure leaves the recovery
 * file in place and is reported as a `[WARN]` line plus an outcome: this runs inside a lock holder's own
 * task and must never throw.
 *
 * Publication and consumption are serialized by a short lock of their own
 * (`<workflowDir>/.result-recovery.lock`). A deferral writes outside the handoff lock by design — that is
 * the lock the repair could not take — so without it a payload published between the replay's read and
 * its removal would be the payload the replay removes, leaving a damaged result behind with no good copy
 * at all. The recovery lock is held only for one local read-and-apply, so a deferral never waits for the
 * long-lived handoff lock.
 *
 * A restore also puts the run back where the checkpoint ordering had it (`orderedAt`: the result's own
 * mtime when it was judged damaged, or the instant it was found missing). Newest-run selection reads that
 * mtime, so a repair must not read as newer workflow progress than a run that actually wrote after it.
 *
 * `runStateWrite` comes from `@/runstate/store`, never the `@/runstate` barrel: `repair.ts` imports
 * this module, so the barrel would close a runtime import cycle (`check:import-cycles`). Every log
 * line is `storyId: "_run"`-first at the `runstate` stage.
 */
import { constants } from "node:fs";
import { appendFile, type FileHandle, lstat, mkdir, open, readdir, rename, unlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage, withFileLock } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { runStateWrite } from "@/runstate/store";
import { writeStagedFile } from "./atomic-write";

/** `<runDir>/result.recovery.json`: the good bytes of a damaged result.json a repair could not restore. */
export const RESULT_RECOVERY_FILE = "result.recovery.json";

export interface ResultRecovery {
  readonly schemaVersion: 1;
  /** The result path relative to the repository root, as `KeptFile.rel` spells it. */
  readonly rel: string;
  /** What the repair saw on disk: no file, or a file whose raw bytes hash to `sha256` (lowercase hex). */
  readonly damaged: { readonly kind: "missing" } | { readonly kind: "modified"; readonly sha256: string };
  /** The kept (good) result.json text. */
  readonly content: string;
  /**
   * The epoch-millisecond time of the run's place in the newest-first ordering: the damaged result's own
   * mtime, or the instant the repair found it missing. The restore writes it back, so replaying an older
   * run does not make it the newest run — which would hide a newer run's handoff mark from the publish and
   * handoff guards.
   */
  readonly orderedAt?: number;
}

export type RecoveryOutcome =
  | { readonly kind: "restored"; readonly resultPath: string }
  | { readonly kind: "superseded"; readonly resultPath: string }
  | { readonly kind: "unreadable"; readonly recoveryPath: string }
  | { readonly kind: "failed"; readonly recoveryPath: string };

/** Test seam for the module's filesystem calls, as `_resultDeps` is for result.ts. */
export const _resultRecoveryDeps = { lstat, mkdir, open, readdir, rename, unlink, utimes };

type RecoveryDamage = ResultRecovery["damaged"];

const RESULT_FILE = "result.json";
/** The run's ledger, as `ledgerFilePath` in `workflow/ledger.ts` names it. */
const LEDGER_FILE = "ledger.md";
/** The repair is nax's own work, not a story's: `repair.ts` reports the same scope. */
const REPAIR_STORY_ID = "_run";
const LOG_STAGE = "runstate";
const RECOVERY_SCHEMA_VERSION = 1;
/** A `modified` recovery carries a lowercase hexadecimal SHA-256 digest of the bytes it saw. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** errno codes that mean "there is no such path", which a scan reads as absence rather than failure. */
const MISSING_PATH_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);
/** Read-only, never through a link, and never blocking: a FIFO answers the open instead of waiting for a writer. */
const PLAIN_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/**
 * The recovery lock: `<workflowDir>/.result-recovery.lock`. A `.`-prefixed regular file, so neither this
 * module's own scan nor `listRunDirs` mistakes it for a run directory.
 */
const RECOVERY_LOCK_FILE = ".result-recovery.lock";
/**
 * How long either side waits for the recovery lock. Both hold it for one local file operation and
 * nothing else, so this bounds a pathological filesystem rather than a peer's work — and, unlike the
 * handoff lock, it is never held across a network wait.
 */
const RECOVERY_LOCK_WAIT_MS = 5_000;

function warn(message: string, data: Record<string, unknown> = {}): void {
  getSafeLogger()?.warn(LOG_STAGE, message, { storyId: REPAIR_STORY_ID, ...data });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** A time this module can hand to `utimes`: a finite number of epoch milliseconds. */
function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The errno code of a thrown filesystem error, when it carries one. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function isMissingPath(error: unknown): boolean {
  const code = errnoCode(error);
  return code !== undefined && MISSING_PATH_CODES.has(code);
}

/** What a plain-file read found: the read's value, or which check refused the path. */
type PlainRead<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: "absent" | "not-plain" };

/**
 * Read `path` only if it is a regular file: opened read-only, never through a link, never blocking, and
 * verified by the opened handle's own stat before a byte is read. A path that is absent, a link, a FIFO,
 * a socket or a directory is reported as such; any other failure propagates.
 *
 * @param path - The file to read
 * @param read - The read to make through the verified handle
 */
async function readPlainFile<T>(path: string, read: (handle: FileHandle) => Promise<T>): Promise<PlainRead<T>> {
  let handle: FileHandle;
  try {
    handle = await _resultRecoveryDeps.open(path, PLAIN_FILE_FLAGS);
  } catch (error) {
    if (isMissingPath(error)) return { ok: false, kind: "absent" };
    const code = errnoCode(error);
    // ELOOP: a link in place of the file. ENXIO: a socket.
    if (code === "ELOOP" || code === "ENXIO") return { ok: false, kind: "not-plain" };
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) return { ok: false, kind: "not-plain" };
    return { ok: true, value: await read(handle) };
  } finally {
    await handle.close();
  }
}

/** The recovery a file holds, or undefined when it is not one this module may act on (fail closed). */
function parseRecovery(text: string): ResultRecovery | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A file that does not parse cannot say what to restore.
    return undefined;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== RECOVERY_SCHEMA_VERSION) return undefined;
  if (typeof parsed.rel !== "string" || typeof parsed.content !== "string") return undefined;
  if (parsed.orderedAt !== undefined && !isEpochMs(parsed.orderedAt)) return undefined;
  const orderedAt = isEpochMs(parsed.orderedAt) ? { orderedAt: parsed.orderedAt } : {};
  const damaged = parsed.damaged;
  if (!isRecord(damaged)) return undefined;
  if (damaged.kind === "missing") {
    return {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      rel: parsed.rel,
      damaged: { kind: "missing" },
      content: parsed.content,
      ...orderedAt,
    };
  }
  if (damaged.kind === "modified" && isSha256Hex(damaged.sha256)) {
    return {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      rel: parsed.rel,
      damaged: { kind: "modified", sha256: damaged.sha256 },
      content: parsed.content,
      ...orderedAt,
    };
  }
  return undefined;
}

/**
 * Whether the result still holds the damage the recovery records, raw on-disk bytes and all.
 *
 * `"unreadable"` for a result this module cannot read as a plain file: writing over it, or discarding
 * the good copy beside it, is exactly what a recovery it cannot verify must never do.
 */
async function holdsDamage(resultPath: string, damaged: RecoveryDamage): Promise<boolean | "unreadable"> {
  const read = await readPlainFile(resultPath, (handle) => handle.readFile());
  if (!read.ok) return read.kind === "absent" ? damaged.kind === "missing" : "unreadable";
  if (damaged.kind === "missing") return false;
  return new Bun.CryptoHasher("sha256").update(read.value).digest("hex") === damaged.sha256;
}

/**
 * Put the run back at the ordering time the recovery recorded. A failure is reported, not thrown: the
 * result is already restored, and the caller's own work matters more than the mtime.
 */
async function restoreOrdering(resultPath: string, orderedAt: number | undefined): Promise<string | undefined> {
  if (orderedAt === undefined) return undefined;
  const seconds = orderedAt / 1000;
  try {
    await _resultRecoveryDeps.utimes(resultPath, seconds, seconds);
    return undefined;
  } catch (error) {
    return `could not keep the run's ordering time: ${errorMessage(error)}`;
  }
}

/**
 * Commit the kept text as the result through a private staging sibling, then restore the run's place in
 * the checkpoint ordering.
 *
 * @returns Why the ordering could not be restored, when it could not
 */
async function commitResult(resultPath: string, recovery: ResultRecovery): Promise<string | undefined> {
  const { content } = recovery;
  await runStateWrite(resultPath, { content }, () => writeStagedFile(resultPath, content, _resultRecoveryDeps));
  return await restoreOrdering(resultPath, recovery.orderedAt);
}

/** Best effort removal of a recovery file: why it is still there, when it is. */
async function removeQuietly(path: string): Promise<string | undefined> {
  try {
    await _resultRecoveryDeps.unlink(path);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

/** The message with each note that something did not happen appended in parentheses. */
function withNotes(message: string, notes: readonly (string | undefined)[]): string {
  const kept = notes.filter((note): note is string => note !== undefined);
  return kept.length === 0 ? message : `${message} (${kept.join("; ")})`;
}

/** Whether the path is a regular file this module may append to: `lstat` does not follow a link. */
async function isPlainFile(path: string): Promise<boolean> {
  try {
    return (await _resultRecoveryDeps.lstat(path)).isFile();
  } catch {
    // A ledger this process cannot stat is not one it may append to.
    return false;
  }
}

/**
 * Note the restore in the run's own ledger, when it has one, so a reader of the ledger alone learns
 * that nax replaced a damaged result. Through `runStateWrite` and without the run-log mirror, the
 * form `appendLedger` uses: an active keeper then records the line as nax's own write.
 */
async function noteInLedger(runDir: string, recovery: ResultRecovery): Promise<void> {
  const ledgerPath = join(runDir, LEDGER_FILE);
  if (!(await isPlainFile(ledgerPath))) return;
  const line = `${REPAIR_STORY_ID}: run-state repaired: ${recovery.rel} (${recovery.damaged.kind})\n`;
  try {
    await runStateWrite(ledgerPath, { append: line }, () => appendFile(ledgerPath, line));
  } catch (error) {
    warn(`[WARN] restored ${recovery.rel} but could not note it in ${ledgerPath} (${errorMessage(error)})`, {
      path: ledgerPath,
    });
  }
}

function failed(recoveryPath: string, resultPath: string, error: unknown): RecoveryOutcome {
  const reason = errorMessage(error);
  warn(`[WARN] could not apply ${recoveryPath}, so it is kept for the next handoff-lock holder (${reason})`, {
    path: resultPath,
    recoveryPath,
    error: reason,
  });
  return { kind: "failed", recoveryPath };
}

/** A newer write replaced the damaged result: the recovery has nothing left to restore. */
async function supersede(resultPath: string, recoveryPath: string): Promise<RecoveryOutcome> {
  const unlinkError = await removeQuietly(recoveryPath);
  warn(
    withNotes(`[WARN] discarded ${recoveryPath}: the result no longer holds the recorded damage`, [
      unlinkError === undefined ? undefined : `could not remove the recovery file: ${unlinkError}`,
    ]),
    {
      path: resultPath,
      recoveryPath,
    },
  );
  return { kind: "superseded", resultPath };
}

/** One run directory: apply its recovery file, discard it, or report why neither happened. */
async function restoreRun(runDir: string): Promise<RecoveryOutcome | undefined> {
  const recoveryPath = join(runDir, RESULT_RECOVERY_FILE);
  const resultPath = join(runDir, RESULT_FILE);
  let read: PlainRead<string>;
  try {
    read = await readPlainFile(recoveryPath, (handle) => handle.readFile("utf8"));
  } catch (error) {
    return failed(recoveryPath, resultPath, error);
  }
  if (!read.ok) {
    // No recovery file: nothing pending. A FIFO, link or directory in its place is a run whose good
    // copy cannot be read, which keeps it on disk and moves on to the next run.
    return read.kind === "absent"
      ? undefined
      : failed(recoveryPath, resultPath, `${recoveryPath} is not a regular file`);
  }
  const recovery = parseRecovery(read.value);
  if (!recovery) {
    warn(`[WARN] left ${recoveryPath} in place: it is not a result recovery file this module can read`, {
      path: recoveryPath,
      resultPath,
    });
    return { kind: "unreadable", recoveryPath };
  }
  let ordering: string | undefined;
  try {
    const holds = await holdsDamage(resultPath, recovery.damaged);
    if (holds === "unreadable") {
      return failed(recoveryPath, resultPath, `${resultPath} is not a regular file this module can read`);
    }
    if (!holds) return await supersede(resultPath, recoveryPath);
    ordering = await commitResult(resultPath, recovery);
  } catch (error) {
    return failed(recoveryPath, resultPath, error);
  }
  const unlinkError = await removeQuietly(recoveryPath);
  await noteInLedger(runDir, recovery);
  warn(
    withNotes(`[WARN] restored ${recovery.rel} from ${recoveryPath}`, [
      ordering,
      unlinkError === undefined ? undefined : `could not remove the recovery file: ${unlinkError}`,
    ]),
    {
      path: recovery.rel,
      recoveryPath,
    },
  );
  return { kind: "restored", resultPath };
}

/** Whether the entry is a real directory this module may read. `lstat` does not follow a link. */
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await _resultRecoveryDeps.lstat(path)).isDirectory();
  } catch {
    // An entry that vanished between the listing and this read, or one this process may not stat,
    // is not a run directory to scan: the workflow dir holds non-directories by design.
    return false;
  }
}

/** Whether anything is at the path at all: `lstat`, so a link or a FIFO counts as present. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await _resultRecoveryDeps.lstat(path);
    return true;
  } catch {
    // A path this process cannot stat is not one it can read either; the locked read reports the failure.
    return false;
  }
}

/**
 * One run directory under the recovery lock: a deferral's publication cannot land between the read of a
 * payload and the removal of the payload read, so neither outcome discards a copy it never consumed.
 *
 * A run with no recovery file — every run, on every result write — is decided by one `lstat` instead: a
 * deferral that publishes an instant after it is simply applied by the next lock-take.
 */
async function restoreLocked(workflowDir: string, runDir: string): Promise<RecoveryOutcome | undefined> {
  const recoveryPath = join(runDir, RESULT_RECOVERY_FILE);
  if (!(await pathExists(recoveryPath))) return undefined;
  try {
    return await withFileLock(join(workflowDir, RECOVERY_LOCK_FILE), () => restoreRun(runDir), {
      lockName: "result-recovery",
      errorPrefix: "[runstate]",
      timeoutMs: RECOVERY_LOCK_WAIT_MS,
    });
  } catch (error) {
    return failed(recoveryPath, join(runDir, RESULT_FILE), error);
  }
}

/** One entry of the workflow directory, when it is a run directory this module may read. */
async function restoreEntry(workflowDir: string, name: string): Promise<RecoveryOutcome | undefined> {
  const runDir = join(workflowDir, name);
  if (!(await isRealDirectory(runDir))) return undefined;
  return await restoreLocked(workflowDir, runDir);
}

/** The workflow directory's entries, or undefined when there is nothing to scan (silently, when absent). */
async function listEntries(workflowDir: string): Promise<string[] | undefined> {
  try {
    return await _resultRecoveryDeps.readdir(workflowDir);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    warn(`[WARN] could not scan ${workflowDir} for result recovery files (${errorMessage(error)})`, {
      path: workflowDir,
      error: errorMessage(error),
    });
    return undefined;
  }
}

/**
 * Under the handoff lock: apply or discard every run's recovery file in `workflowDir`, one run
 * directory at a time. Never throws: a run whose files fail is reported `failed` and left as it was,
 * so the lock holder's own task still runs.
 */
export async function restorePendingResults(workflowDir: string): Promise<readonly RecoveryOutcome[]> {
  const names = await listEntries(workflowDir);
  if (names === undefined) return [];
  const outcomes: RecoveryOutcome[] = [];
  for (const name of names) {
    const outcome = await restoreEntry(workflowDir, name);
    if (outcome !== undefined) outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Create `dirname(resultPath)` (recursive), then write the recovery file beside `resultPath` through a
 * private staging sibling of its own. Replaces an existing one.
 *
 * The write takes the recovery lock a replay holds: a payload that landed between a replay's read and its
 * cleanup would otherwise be removed as if it were the payload the replay consumed.
 */
export async function writeResultRecovery(resultPath: string, recovery: ResultRecovery): Promise<void> {
  const runDir = dirname(resultPath);
  await _resultRecoveryDeps.mkdir(runDir, { recursive: true });
  const recoveryPath = join(runDir, RESULT_RECOVERY_FILE);
  const payload = `${JSON.stringify(recovery, null, 2)}\n`;
  await withFileLock(
    join(dirname(runDir), RECOVERY_LOCK_FILE),
    () => writeStagedFile(recoveryPath, payload, _resultRecoveryDeps),
    {
      lockName: "result-recovery",
      errorPrefix: "[runstate]",
      timeoutMs: RECOVERY_LOCK_WAIT_MS,
    },
  );
}
