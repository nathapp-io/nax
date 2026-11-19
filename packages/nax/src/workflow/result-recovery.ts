/**
 * `<runDir>/result.recovery.json` (#2984): the good bytes of a `result.json` that a run-end or crash
 * repair could not restore because another process held the feature's handoff lock. The repair writes
 * this file beside the result it could not fix; whoever next takes that lock applies it when the
 * result still holds the recorded damage, and discards it when a newer write has replaced the result.
 *
 * Nothing here follows a link: only an entry that `lstat`s as a real directory is a run directory, so
 * a link, a `.handoff.lock` file or anything else in the workflow directory is skipped (as
 * `listRunDirs` in `handoff-record.ts` skips it) and nothing is written through one. A recovery file
 * this module cannot read is left exactly where it is and reported `unreadable`: a file it cannot
 * trust must never overwrite a result. Every other failure leaves the recovery file in place and is
 * reported as a `[WARN]` line plus an outcome, because this runs inside a lock holder's own task and
 * must never throw.
 *
 * `runStateWrite` comes from `@/runstate/store`, never the `@/runstate` barrel: `repair.ts` imports
 * this module, so the barrel would close a runtime import cycle (`check:import-cycles`). Every log
 * line is `storyId: "_run"`-first at the `runstate` stage.
 */
import { appendFile, lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { runStateWrite } from "@/runstate/store";

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
}

export type RecoveryOutcome =
  | { readonly kind: "restored"; readonly resultPath: string }
  | { readonly kind: "superseded"; readonly resultPath: string }
  | { readonly kind: "unreadable"; readonly recoveryPath: string }
  | { readonly kind: "failed"; readonly recoveryPath: string };

/** Test seam for the module's filesystem calls, as `_resultDeps` is for result.ts. */
export const _resultRecoveryDeps = { readdir, lstat, mkdir, rename, unlink };

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

function warn(message: string, data: Record<string, unknown> = {}): void {
  getSafeLogger()?.warn(LOG_STAGE, message, { storyId: REPAIR_STORY_ID, ...data });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
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

/** The read's value, or undefined when there is no such path; every other failure propagates. */
async function readIfPresent<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
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
  const damaged = parsed.damaged;
  if (!isRecord(damaged)) return undefined;
  if (damaged.kind === "missing") {
    return {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      rel: parsed.rel,
      damaged: { kind: "missing" },
      content: parsed.content,
    };
  }
  if (damaged.kind === "modified" && isSha256Hex(damaged.sha256)) {
    return {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      rel: parsed.rel,
      damaged: { kind: "modified", sha256: damaged.sha256 },
      content: parsed.content,
    };
  }
  return undefined;
}

/** Whether the result still holds the damage the recovery records, raw on-disk bytes and all. */
async function holdsDamage(resultPath: string, damaged: RecoveryDamage): Promise<boolean> {
  const bytes = await readIfPresent(() => Bun.file(resultPath).bytes());
  if (damaged.kind === "missing") return bytes === undefined;
  return bytes !== undefined && new Bun.CryptoHasher("sha256").update(bytes).digest("hex") === damaged.sha256;
}

/** Commit the kept text as the result, the way `writeResult` in result.ts does: tmp, then rename. */
async function commitResult(resultPath: string, content: string): Promise<void> {
  const tmp = `${resultPath}.tmp`;
  await runStateWrite(resultPath, { content }, async () => {
    await Bun.write(tmp, content);
    await _resultRecoveryDeps.rename(tmp, resultPath);
  });
}

/** Best effort: the recovery file's removal, or why it is still there. */
async function removeRecovery(recoveryPath: string): Promise<string | undefined> {
  try {
    await _resultRecoveryDeps.unlink(recoveryPath);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function withUnlinkNote(message: string, unlinkError: string | undefined): string {
  return unlinkError === undefined ? message : `${message} (could not remove the recovery file: ${unlinkError})`;
}

/**
 * Note the restore in the run's own ledger, when it has one, so a reader of the ledger alone learns
 * that nax replaced a damaged result. Through `runStateWrite` and without the run-log mirror, the
 * form `appendLedger` uses: an active keeper then records the line as nax's own write.
 */
async function noteInLedger(runDir: string, recovery: ResultRecovery): Promise<void> {
  const ledgerPath = join(runDir, LEDGER_FILE);
  if (!(await Bun.file(ledgerPath).exists())) return;
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
  const unlinkError = await removeRecovery(recoveryPath);
  warn(
    withUnlinkNote(`[WARN] discarded ${recoveryPath}: the result no longer holds the recorded damage`, unlinkError),
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
  let text: string | undefined;
  try {
    text = await readIfPresent(() => Bun.file(recoveryPath).text());
  } catch (error) {
    return failed(recoveryPath, resultPath, error);
  }
  if (text === undefined) return undefined;
  const recovery = parseRecovery(text);
  if (!recovery) {
    warn(`[WARN] left ${recoveryPath} in place: it is not a result recovery file this module can read`, {
      path: recoveryPath,
      resultPath,
    });
    return { kind: "unreadable", recoveryPath };
  }
  try {
    if (!(await holdsDamage(resultPath, recovery.damaged))) return await supersede(resultPath, recoveryPath);
    await commitResult(resultPath, recovery.content);
  } catch (error) {
    return failed(recoveryPath, resultPath, error);
  }
  const unlinkError = await removeRecovery(recoveryPath);
  await noteInLedger(runDir, recovery);
  warn(withUnlinkNote(`[WARN] restored ${recovery.rel} from ${recoveryPath}`, unlinkError), {
    path: recovery.rel,
    recoveryPath,
  });
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

/** One entry of the workflow directory, when it is a run directory this module may read. */
async function restoreEntry(workflowDir: string, name: string): Promise<RecoveryOutcome | undefined> {
  const runDir = join(workflowDir, name);
  if (!(await isRealDirectory(runDir))) return undefined;
  return await restoreRun(runDir);
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

/** Create `dirname(resultPath)` (recursive), then write the recovery file beside `resultPath`. */
export async function writeResultRecovery(resultPath: string, recovery: ResultRecovery): Promise<void> {
  const dir = dirname(resultPath);
  await _resultRecoveryDeps.mkdir(dir, { recursive: true });
  const recoveryPath = join(dir, RESULT_RECOVERY_FILE);
  const tmp = `${recoveryPath}.tmp`;
  await Bun.write(tmp, `${JSON.stringify(recovery, null, 2)}\n`);
  await _resultRecoveryDeps.rename(tmp, recoveryPath);
}
