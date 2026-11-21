/**
 * A file-backed CredentialStore whose modify() holds a cross-process lock.
 *
 * pi-ai serialises credential writes within a process. It cannot serialise
 * across them, so two `nax` invocations refreshing the same OAuth token race:
 * both read the old token, both refresh, and the second write discards the
 * first. The refresh that lost is not recoverable — the provider has already
 * rotated it — so the user is logged out. Holding a lock across the whole
 * read-modify-write is the only fix, which is why CredentialStore exposes
 * modify() rather than a bare write.
 *
 * The lock comes from proper-lockfile rather than a hand-rolled one: the hard
 * part is not taking a lock but releasing one whose owner died, and getting
 * staleness wrong turns a crash into a permanent lockout.
 */

import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { CredentialStore, ProviderId, StoredCredential } from "../types.ts";

/** Owner-only, on both the file and the directory holding it. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * How long a held lock may go unrefreshed before another process may break it.
 * proper-lockfile refreshes the lock's mtime while the holder lives, so this
 * bounds how long a crashed holder blocks everyone else.
 */
const STALE_MS = 10_000;

/** How long to wait for a lock another process is legitimately holding. */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/**
 * Acquisition backoff. The first retry comes quickly, because most contention
 * is a write that finishes almost at once; the growth keeps a long-lived holder
 * from being polled hundreds of times.
 */
const ACQUIRE_BACKOFF_START_MS = 20;
const ACQUIRE_BACKOFF_FACTOR = 1.6;

export interface FileCredentialStoreOptions {
  /** Absolute path to the credential file. Created on first write. */
  readonly path: string;
  /** How long to wait for a contended lock before giving up. */
  readonly lockTimeoutMs?: number;
}

/** What is on disk. Versioned so a later shape change can be detected. */
interface FileShape {
  readonly version: 1;
  readonly credentials: Readonly<Record<string, StoredCredential>>;
}

const EMPTY: FileShape = { version: 1, credentials: {} };

/**
 * Parsing deliberately does not fall back to an empty store. A file that
 * cannot be read is far more likely to be a bug, a partial restore or the
 * wrong path than a file that should be discarded — and discarding it would
 * silently log the user out of every provider at once.
 *
 * Two shapes are refused. A `credentials` value that is not an object (null, an
 * array, a string) cannot be a credential map, and a `version` other than 1 is a
 * layout this build does not understand. Writing either back as version 1 would
 * destroy it: an array would be re-keyed by index, and a later version would be
 * silently downgraded. Refusing costs one clear error; overwriting costs the
 * user every credential in the file.
 *
 * The cause is not attached: a JSON parse error quotes the text it failed on,
 * which here is the credential file. Neither message quotes the file, so no
 * stored key reaches a log or a terminal.
 */
async function readShape(path: string): Promise<FileShape> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The credential file at ${path} could not be parsed. Refusing to overwrite it.`);
  }

  if (!isRecord(parsed) || !isRecord(parsed.credentials)) {
    throw new Error(
      `The credential file at ${path} could not be parsed as a credential store. Refusing to overwrite it.`,
    );
  }
  if (parsed.version !== 1) {
    throw new Error(`The credential file at ${path} is not a version 1 credential store. Refusing to overwrite it.`);
  }
  // The entries themselves are not validated: a store that cannot read back one
  // provider's credential is a different failure, and this gate is about the
  // file's shape.
  return { version: 1, credentials: parsed.credentials as Readonly<Record<string, StoredCredential>> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write through a temporary file in the same directory, then rename. rename is
 * atomic within a filesystem, so a reader never observes a half-written file
 * and a crash mid-write leaves the previous credentials intact. That is what
 * lets read() skip the lock entirely.
 */
async function writeShape(path: string, shape: FileShape, createOnly = false): Promise<void> {
  const temp = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(shape, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    // writeFile's mode applies only when it creates the file, and rename
    // preserves the source's mode, so set it explicitly.
    await chmod(temp, FILE_MODE);
    if (createOnly) {
      // Publish complete JSON without replacing a concurrent initializer or
      // writer. Opening the destination with wx would expose partial JSON.
      try {
        await link(temp, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } else {
      await rename(temp, path);
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/**
 * Releases a lock nobody was handed, without letting the cleanup decide what
 * the caller sees. The caller has already been answered — with a timeout — so
 * a slow release must not delay that answer and a failing one must not replace
 * it with an error about a lock the caller never held.
 */
function releaseQuietly(release: () => Promise<void>): void {
  release().catch(() => {});
}

export function createFileCredentialStore(options: FileCredentialStoreOptions): CredentialStore {
  const { path } = options;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  /** proper-lockfile locks an existing path, so the file must be there first. */
  async function ensureFile(): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    await writeShape(path, EMPTY, true);
  }

  /** What one bounded lock() call came to. */
  type Attempt =
    | { readonly kind: "acquired"; readonly release: () => Promise<void> }
    | { readonly kind: "held"; readonly error: unknown }
    | { readonly kind: "deadline" };

  /**
   * One lock() call, raced against the time left before the deadline.
   *
   * The attempt itself is filesystem I/O and can settle long after the budget
   * has gone: probed with a 20 ms budget, lock() answered at 67 ms. Awaiting it
   * reports the timeout whenever that call happens to finish, so the wait is
   * bounded by a timer instead.
   *
   * An attempt abandoned this way is not cancelled — lock() keeps running — so
   * whatever it wins afterwards is released at once. Nobody was handed it, and
   * keeping it would block every writer until it went stale. Its late rejection
   * is swallowed for the same reason: the caller has already been answered.
   */
  function attemptLock(remainingMs: number): Promise<Attempt> {
    const pending = lockfile.lock(path, { realpath: false, stale: STALE_MS, retries: 0 });
    return new Promise<Attempt>((resolve) => {
      const timer = setTimeout(() => {
        pending.then(releaseQuietly, () => {});
        resolve({ kind: "deadline" });
      }, remainingMs);

      pending.then(
        (release) => {
          clearTimeout(timer);
          resolve({ kind: "acquired", release });
        },
        (error: unknown) => {
          clearTimeout(timer);
          resolve({ kind: "held", error });
        },
      );
    });
  }

  /**
   * One deadline for the whole acquisition, not a per-attempt maximum.
   *
   * proper-lockfile's own retry loop multiplies a capped backoff by its retry
   * count, so `lockTimeoutMs` used to bound each wait instead of the total: a
   * caller asking for 200 ms could wait over a second, and a lock released
   * after the deadline could still be taken. Here each attempt is a single
   * non-retrying lock() call bounded by the time left, and the deadline is
   * checked before each attempt, after each sleep, and once more when an
   * attempt succeeds — the last one because lock() can answer just past the
   * deadline on a busy event loop that delayed the timer.
   */
  async function acquire(): Promise<() => Promise<void>> {
    const deadline = Date.now() + lockTimeoutMs;
    let backoff = ACQUIRE_BACKOFF_START_MS;
    let lastError: unknown;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw lockTimeout(lastError);

      const attempt = await attemptLock(remaining);
      if (attempt.kind === "deadline") throw lockTimeout(lastError);

      if (attempt.kind === "acquired") {
        // A lock that arrives after the deadline is not one this caller asked
        // to wait for, and the caller's callback must not run under it. It is
        // released rather than kept, so a late acquisition does not leave the
        // file locked for everyone else. The release is not awaited for the
        // same reason the abandoned attempt's is not: it is cleanup, and the
        // caller's answer is already overdue.
        if (Date.now() < deadline) return attempt.release;
        releaseQuietly(attempt.release);
        throw lockTimeout(lastError);
      }

      if ((attempt.error as NodeJS.ErrnoException).code !== "ELOCKED") throw attempt.error;
      lastError = attempt.error;
      const left = deadline - Date.now();
      if (left <= 0) throw lockTimeout(lastError);
      await sleep(Math.min(backoff, left));
      backoff *= ACQUIRE_BACKOFF_FACTOR;
    }
  }

  function lockTimeout(cause: unknown): Error {
    return new Error(`Timed out waiting for the credential file lock at ${path}. Another process is holding it.`, {
      cause,
    });
  }

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    await ensureFile();
    const release = await acquire();
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  return {
    // Unlocked on purpose: writeShape renames into place, so a concurrent
    // write is either wholly visible or not visible at all. Taking the lock
    // here would make every read create the file and contend with refreshes.
    async read(providerId: ProviderId): Promise<StoredCredential | undefined> {
      return (await readShape(path)).credentials[providerId];
    },

    async modify(
      providerId: ProviderId,
      fn: (current: StoredCredential | undefined) => Promise<StoredCredential | undefined>,
    ): Promise<StoredCredential | undefined> {
      return withLock(async () => {
        const shape = await readShape(path);
        const next = await fn(shape.credentials[providerId]);
        const credentials =
          next === undefined
            ? Object.fromEntries(Object.entries(shape.credentials).filter(([id]) => id !== providerId))
            : { ...shape.credentials, [providerId]: next };
        await writeShape(path, { ...shape, credentials });
        return next;
      });
    },

    async delete(providerId: ProviderId): Promise<void> {
      await this.modify(providerId, async () => undefined);
    },
  };
}
