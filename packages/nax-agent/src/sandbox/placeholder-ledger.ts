/**
 * US-002 — the process-wide ledger of the paths a Linux wrap may have created a
 * bwrap placeholder at.
 *
 * srt creates a mount placeholder for a deny path that is ABSENT, so nax cannot
 * tell, later, whether a file at that name is bwrap's or the user's. It can tell
 * if it records the exact inode it saw appear: an entry is **pending** from the
 * moment a wrap could have created a placeholder (`recordAbsent`), and carries
 * the placeholder's `{ kind, dev, ino }` once one has been seen (`observe`).
 * `prune` then drops the entries whose inode is gone. Nothing here deletes a
 * user path — US-004's sweep decides removal, from this record.
 *
 * The file is `<ledgerDir>/<pid>.json`, mode 0600, written atomically through
 * `.<pid>.tmp` and a rename, so a sweep of another process never reads a half
 * written ledger. It is also the sweep's only source of truth about a dead
 * process, so every read is a **trust check** of the file's own shape: a regular
 * file, this user's, no group or other bits, version 1, named for its pid, with
 * absolute normalised entry paths. A file that fails is refused as a whole.
 *
 * Synchronous `node:fs` throughout, as `session-tmp.ts` is: the backend's
 * `commandFinished` and the exit hook that call this are synchronous (nax-agent
 * is a Node library and uses no Bun API). Every host fact is read from
 * `_placeholderDeps` (US-001) at call time, so a later story can drive the whole
 * lifecycle from a test without touching the filesystem seam.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, type Stats, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize } from "node:path";
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger } from "#src/infra/index";
import { _placeholderDeps } from "./placeholder-deps.ts";
import { type PlaceholderIdentity, type PlaceholderKind, placeholderIdentity } from "./placeholder-paths.ts";

/** The one ledger format this module writes and reads. */
const LEDGER_VERSION = 1;

/** Owner read/write only: the ledger names the paths a sandbox may have touched. */
const LEDGER_FILE_MODE = 0o600;

/** Owner only: the directory is not shared, and US-005 denies it to sandboxed commands. */
const LEDGER_DIR_MODE = 0o700;

/** One recorded path: `pending` (no identity yet) or identified by its inode. */
export interface LedgerEntry {
  readonly path: string;
  readonly kind?: PlaceholderKind;
  readonly dev?: number;
  readonly ino?: number;
}

/** A ledger file as it is stored: the process that wrote it and what it recorded. */
export interface LedgerFile {
  readonly version: number;
  readonly pid: number;
  readonly bootId: string;
  readonly startTicks: number;
  readonly entries: readonly LedgerEntry[];
}

/** What a prune keeps and what it drops: `prune(opts)` decides. */
export interface PruneOptions {
  /**
   * Drop the pending entries too (US-004). A pending entry is a path a wrap MAY
   * have created a placeholder at but none was seen at; once no wrap is left to
   * identify it, nothing ever will, and leaving it lets a user file created later
   * at that path be adopted by the next `observe`.
   */
  readonly abandonPending?: boolean;
}

/** The ledger a process keeps of the placeholders its own wraps may have made. */
export interface PlaceholderLedger {
  /** Record every path a wrap could create a placeholder at, skipping the ones already known. */
  recordAbsent(paths: readonly string[]): void;
  /**
   * Record the identity of every pending path that is now a placeholder.
   * Returns how many entries are still pending afterwards.
   */
  observe(): number;
  /** Drop the identified entries whose placeholder is no longer on disk, and the pending ones too with `abandonPending`. */
  prune(opts?: PruneOptions): void;
}

/** One warn naming the file a trust check refused, and no ledger from it. */
function rejected(path: string, reason: string): undefined {
  getSafeLogger()?.warn("sandbox", "placeholder ledger failed the trust check", { file: path, reason });
  return undefined;
}

/** `path` in the form a ledger entry stores, or `undefined` when it is not absolute. */
function normaliseEntryPath(path: string): string | undefined {
  const normalised = normalize(path);
  return isAbsolute(normalised) ? normalised : undefined;
}

/** True when `path` is absolute and already in the form {@link normaliseEntryPath} produces. */
function isNormalisedAbsolute(path: string): boolean {
  return normaliseEntryPath(path) === path;
}

/**
 * The `lstat` of `path`, or `undefined` when there is nothing there to inspect.
 *
 * Only `ENOENT` and `ENOTDIR` prove that no ledger is at this path, and they are
 * the silent cases: the sweep skips a ledger another sweep has already deleted.
 * Every other failure — `EACCES` from an unsearchable parent, `EIO` — leaves the
 * question open, so it is reported by file name, like any other refusal, instead
 * of hiding a trust check that never ran (M1).
 */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return rejected(path, `not inspectable: ${errorMessage(error)}`);
  }
}

/** The identity `raw` records, or `undefined` when it is missing, partial or malformed. */
function identityOf(raw: Record<string, unknown>): PlaceholderIdentity | undefined {
  const { kind, dev, ino } = raw;
  if (kind !== "file" && kind !== "dir") return undefined;
  if (typeof dev !== "number" || !Number.isInteger(dev)) return undefined;
  if (typeof ino !== "number" || !Number.isInteger(ino)) return undefined;
  return { kind, dev, ino };
}

/**
 * One entry of a ledger file, or `undefined` when it holds no usable path.
 *
 * A partial or malformed identity degrades to **pending** rather than refusing
 * the file: an entry's inode fields are the sweep's business (US-004), which
 * drops such an entry without touching the disk, and a pending entry is never
 * removed. Only a path that is relative or not normalised is a file-level
 * failure — it could name a location outside the writer's own tree.
 */
function parseEntry(raw: unknown): LedgerEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const path = record.path;
  if (typeof path !== "string" || !isNormalisedAbsolute(path)) return undefined;
  const identity = identityOf(record);
  return identity === undefined ? { path } : { path, ...identity };
}

/** `raw` as a ledger file, or `undefined` when any field fails the trust check. */
function parseLedgerFile(path: string, raw: unknown): LedgerFile | undefined {
  if (typeof raw !== "object" || raw === null) return rejected(path, "content is not an object");
  const record = raw as Record<string, unknown>;
  const { version, pid, bootId, startTicks, entries } = record;
  if (version !== LEDGER_VERSION) return rejected(path, `unsupported version ${String(version)}`);
  if (typeof pid !== "number" || !Number.isInteger(pid)) return rejected(path, "pid is not an integer");
  if (typeof bootId !== "string" || bootId === "") return rejected(path, "bootId is not a string");
  if (typeof startTicks !== "number" || !Number.isInteger(startTicks)) {
    return rejected(path, "startTicks is not an integer");
  }
  if (basename(path) !== `${pid}.json`) return rejected(path, `name does not match pid ${pid}`);
  if (!Array.isArray(entries)) return rejected(path, "entries is not an array");
  const parsed: LedgerEntry[] = [];
  for (const rawEntry of entries) {
    const entry = parseEntry(rawEntry);
    if (entry === undefined) return rejected(path, "an entry path is not absolute and normalised");
    parsed.push(entry);
  }
  return { version: LEDGER_VERSION, pid, bootId, startTicks, entries: parsed };
}

/**
 * The ledger stored at `path`, or `undefined` when it is not a file this process
 * may trust.
 *
 * The only reader of a ledger file, and the only place the trust check lives:
 * a regular file (never a symlink or a directory), owned by
 * `_placeholderDeps.uid()`, with no group or other permission bit, holding
 * version 1 JSON whose name matches its own pid and whose entry paths are
 * absolute and normalised.
 */
export function readLedgerFile(path: string): LedgerFile | undefined {
  const stats = lstatOrUndefined(path);
  if (stats === undefined) return undefined;
  if (!stats.isFile()) return rejected(path, "not a regular file");
  if (stats.uid !== _placeholderDeps.uid()) return rejected(path, "owned by another user");
  if ((stats.mode & 0o077) !== 0) return rejected(path, "accessible by group or other");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    // The modes looked right but the bytes did not arrive: without them nothing
    // can be checked, so the file is not trusted.
    return rejected(path, `unreadable: ${errorMessage(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return rejected(path, "content is not JSON");
  }
  return parseLedgerFile(path, raw);
}

/** The process facts a ledger file carries, read once when the ledger is created. */
interface LedgerHost {
  readonly dir: string;
  readonly pid: number;
  readonly bootId: string;
  readonly startTicks: number;
}

/** The process ledger, plus the exit hook's own handle on the file it writes. */
interface ProcessLedger extends PlaceholderLedger {
  /** Unlink this process's ledger file, ignoring any failure. */
  deleteFile(): void;
}

/** True when no identity has been recorded for the entry yet. */
function isPending(entry: LedgerEntry): boolean {
  return entry.kind === undefined || entry.dev === undefined || entry.ino === undefined;
}

/** True when the thing on disk is still the very inode the entry recorded. */
function matchesDisk(entry: LedgerEntry): boolean {
  const identity = placeholderIdentity(entry.path);
  return (
    identity !== undefined && identity.kind === entry.kind && identity.dev === entry.dev && identity.ino === entry.ino
  );
}

/** Delete `path`, ignoring any failure: a missing file is the caller's expected outcome. */
function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or not ours to remove. The next sweep finds a dead owner.
  }
}

/**
 * The ledger for one process, writing `<dir>/<pid>.json` and nothing else.
 *
 * `entries` is the whole in-memory state: a write happens only when a call
 * changed it, so a wrap that finds nothing new neither rewrites the file nor
 * churns its inode.
 */
function createLedger(host: LedgerHost): ProcessLedger {
  const filePath = join(host.dir, `${host.pid}.json`);
  const tempPath = join(host.dir, `.${host.pid}.tmp`);
  let entries: LedgerEntry[] = [];
  let warnedWriteFailure = false;

  /** Atomic: a full temp file renamed over the ledger, so a reader never sees a partial one. */
  function write(): void {
    const file: LedgerFile = {
      version: LEDGER_VERSION,
      pid: host.pid,
      bootId: host.bootId,
      startTicks: host.startTicks,
      entries,
    };
    try {
      mkdirSync(host.dir, { recursive: true, mode: LEDGER_DIR_MODE });
      writeFileSync(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: LEDGER_FILE_MODE });
      renameSync(tempPath, filePath);
    } catch (err) {
      removeQuietly(tempPath);
      // One warn per process: a command whose ledger cannot be written still
      // runs, and later writes are still attempted.
      if (warnedWriteFailure) return;
      warnedWriteFailure = true;
      getSafeLogger()?.warn("sandbox", "placeholder ledger write failed", {
        file: filePath,
        error: errorMessage(err),
      });
    }
  }

  return {
    recordAbsent(paths: readonly string[]): void {
      let changed = false;
      for (const path of paths) {
        const recorded = normaliseEntryPath(path);
        if (recorded === undefined) continue;
        if (entries.some((entry) => entry.path === recorded)) continue;
        entries.push({ path: recorded });
        changed = true;
      }
      if (changed) write();
    },

    observe(): number {
      let changed = false;
      entries = entries.map((entry) => {
        if (!isPending(entry)) return entry;
        const identity = placeholderIdentity(entry.path);
        if (identity === undefined) return entry;
        changed = true;
        return { path: entry.path, ...identity };
      });
      if (changed) write();
      return entries.filter(isPending).length;
    },

    prune(opts?: PruneOptions): void {
      const kept = entries.filter(
        (entry) =>
          // Pending entries stay unless the caller abandons them: another wrapped
          // command may still be starting the placeholder this one has not seen
          // yet, and a pending entry names no inode to compare.
          matchesDisk(entry) || (opts?.abandonPending !== true && isPending(entry)),
      );
      const changed = kept.length !== entries.length;
      entries = kept;
      if (entries.length === 0) {
        removeQuietly(filePath);
        return;
      }
      if (changed) write();
    },

    deleteFile(): void {
      removeQuietly(filePath);
    },
  };
}

/** Create the ledger directory ahead of the first policy that denies it to a command. */
function ensureLedgerDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: LEDGER_DIR_MODE });
  } catch {
    // Creation must never throw — `wrap` calls this on the command path. The
    // first write retries it and reports the failure once.
  }
}

/** Why a ledger is not kept on this host, for the one debug line that says so. */
function disabled(reason: string): undefined {
  getSafeLogger()?.debug("sandbox", "placeholder ledger disabled", { reason });
  return undefined;
}

/** The ledger for this process, or `undefined` when this host cannot keep one. */
function createProcessLedger(): ProcessLedger | undefined {
  if (_placeholderDeps.platform() !== "linux") return disabled("placeholder ledgers are Linux only");
  let host: LedgerHost;
  try {
    host = {
      dir: _placeholderDeps.ledgerDir(),
      pid: process.pid,
      bootId: _placeholderDeps.bootId(),
      startTicks: _placeholderDeps.startTicks(process.pid),
    };
  } catch (err) {
    return disabled(errorMessage(err));
  }
  ensureLedgerDir(host.dir);
  // F1: capture the directory here, once. Every later reader -- the deny in
  // `placeholderLedgerDirForPolicy` in particular -- takes this value instead of
  // asking the provider again: it can go away mid-run (`credentialsConfig()`
  // throws once the host is unconfigured), and a provider read must never abort
  // policy construction for a path the ledger already owns.
  capturedLedgerDir = host.dir;
  const ledger = createLedger(host);
  // One hook per process, registered before any wrap, deleting the file whatever
  // it still holds: the entries are this process's, and it will not observe again.
  _placeholderDeps.onExit(() => {
    ledger.deleteFile();
  });
  return ledger;
}

let ledger: ProcessLedger | undefined;

/**
 * The directory {@link ledger} was created with, captured at creation (F1).
 *
 * Never re-read from `_placeholderDeps.ledgerDir()`: that provider is a host
 * fact that can fail after the ledger exists (`credentialsConfig()` throws once
 * the host is unconfigured), and a policy built for a command must not abort
 * because the directory it should deny can no longer be looked up — the ledger
 * already owns the path, and `undefined` here is what "no ledger" means.
 */
let capturedLedgerDir: string | undefined;

/**
 * True once creation has been attempted — the ledger singleton's own flag, and
 * the exit hook's: one disable line per process, one hook, however many wraps.
 */
let initialised = false;

/**
 * The process-wide ledger, created on first call, or `undefined` when this host
 * cannot keep one (not Linux, or the ledger directory, boot id or start ticks
 * are unavailable). Callers proceed without it: no ledger means no deny.
 */
export function placeholderLedger(): PlaceholderLedger | undefined {
  if (!initialised) {
    initialised = true;
    ledger = createProcessLedger();
  }
  return ledger;
}

/** Clears the process ledger and its one-attempt flag. Tests only. @internal */
export function _resetPlaceholderLedgerForTests(): void {
  ledger = undefined;
  capturedLedgerDir = undefined;
  initialised = false;
}

/**
 * US-005 — the ledger directory a sandboxed command must not write, or
 * `undefined` when this host keeps no ledger.
 *
 * Read per policy build, and read AFTER {@link placeholderLedger}, so the deny
 * exists exactly when a ledger does: never on a host that is not Linux, and
 * never when this process's directory, boot id or start ticks were unavailable
 * (those readers disable the ledger; they do not throw out of here, because the
 * ledger is created first and a disabled ledger is `undefined`).
 *
 * The directory is the one the ledger was CREATED with, not a fresh
 * `_placeholderDeps.ledgerDir()` call (F1): re-reading a host provider here would
 * let a provider that failed after creation abort policy construction, for a
 * path the ledger already owns. The ledger created its 0700 directory as it was
 * created, so the path exists. It must be denied: a command that could write
 * there could add or remove the entries the sweep trusts when it decides which
 * placeholder to delete, and the user's own file is what that decision protects.
 */
export function placeholderLedgerDirForPolicy(): string | undefined {
  if (placeholderLedger() === undefined) return undefined;
  return capturedLedgerDir;
}
