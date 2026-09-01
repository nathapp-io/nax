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

import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parsing deliberately does not fall back to an empty store. A file that
 * cannot be read is far more likely to be a bug, a partial restore or the
 * wrong path than a file that should be discarded — and discarding it would
 * silently log the user out of every provider at once.
 *
 * The cause is not attached: a JSON parse error quotes the text it failed on,
 * which here is the credential file.
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

  if (typeof parsed !== "object" || parsed === null || !("credentials" in parsed)) {
    throw new Error(
      `The credential file at ${path} could not be parsed as a credential store. Refusing to overwrite it.`,
    );
  }
  return parsed as FileShape;
}

/**
 * Write through a temporary file in the same directory, then rename. rename is
 * atomic within a filesystem, so a reader never observes a half-written file
 * and a crash mid-write leaves the previous credentials intact. That is what
 * lets read() skip the lock entirely.
 */
async function writeShape(path: string, shape: FileShape): Promise<void> {
  const temp = join(dirname(path), `.${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(shape, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
    // writeFile's mode applies only when it creates the file, and rename
    // preserves the source's mode, so set it explicitly.
    await chmod(temp, FILE_MODE);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export function createFileCredentialStore(options: FileCredentialStoreOptions): CredentialStore {
  const { path } = options;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  /** proper-lockfile locks an existing path, so the file must be there first. */
  async function ensureFile(): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    if (!(await exists(path))) await writeShape(path, EMPTY);
  }

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    await ensureFile();
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(path, {
        realpath: false,
        stale: STALE_MS,
        retries: { retries: 10, factor: 1.6, minTimeout: 20, maxTimeout: lockTimeoutMs },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
        throw new Error(`Timed out waiting for the credential file lock at ${path}. Another process is holding it.`, {
          cause: error,
        });
      }
      throw error;
    }

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
