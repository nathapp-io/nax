/**
 * Keyed credential fingerprints (US-002).
 *
 * A fingerprint lets a run report "the credential this call was billed to has
 * changed" without ever logging the credential: the first 12 lowercase hex
 * characters of HMAC-SHA-256 over the credential's identifying secret, keyed by
 * a per-machine salt held in `<globalConfigDir>/auth-fingerprint-salt`.
 *
 * The salt is what makes the digest useless as a lookup key, and it is per
 * machine by design — a fingerprint cannot be compared across machines. Its
 * creation is an exclusive create at mode 0600, so a process that loses the
 * creation race reads the winner's file instead of overwriting it.
 */

import { createHmac, randomBytes } from "node:crypto";
import { type FileHandle, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StoredCredential } from "@nathapp/nax-ai";
import { globalConfigDir } from "@/config";
import { getSafeLogger } from "@/logger";

/** Exactly one HMAC key's worth. Anything shorter is a damaged file, not a salt. */
const SALT_BYTES = 32;
const SALT_FILENAME = "auth-fingerprint-salt";
/** Lowercase hex characters retained from the digest. */
const FINGERPRINT_CHARS = 12;

/**
 * Salt memo, and the salt-file path it belongs to: `NAX_GLOBAL_CONFIG_DIR`
 * moves between tests, and a salt cached for a stale path would make every
 * fingerprint in the new directory wrong.
 */
let memoPath: string | undefined;
let memoSalt: Buffer | undefined;

/** Salt-file paths already reported invalid, so the event is emitted once per file. */
const warnedInvalidPaths = new Set<string>();

/** Clears the salt memo and the warn-once set. Tests only. */
export function _resetFingerprintSalt(): void {
  memoPath = undefined;
  memoSalt = undefined;
  warnedInvalidPaths.clear();
}

/** Absolute path of the per-machine salt file. */
function saltFilePath(): string {
  return join(globalConfigDir(), SALT_FILENAME);
}

/** Read the salt file. `undefined` when it does not exist. */
async function readSaltFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Create the salt file, or read the winner's when another process beat us to it.
 *
 * Bun has no exclusive-create API, so the `wx` open flag is the only way to make
 * first creation atomic; an `EEXIST` there is the race, not a failure.
 */
async function createSaltFile(path: string): Promise<Buffer | undefined> {
  const candidate = randomBytes(SALT_BYTES);
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readSaltFile(path);
    throw error;
  }
  try {
    await handle.writeFile(candidate);
  } finally {
    await handle.close();
  }
  return candidate;
}

/**
 * Load the machine salt, creating it on first use.
 *
 * A file that is not exactly 32 bytes is left untouched: it is replaced by a
 * random in-memory salt for this process, and `credential.salt_invalid` is
 * logged once for that path. Rewriting the file would destroy whatever an
 * operator put there, and reusing a short read would be worse than a fresh key.
 */
async function loadSalt(path: string): Promise<Buffer> {
  const stored = (await readSaltFile(path)) ?? (await createSaltFile(path));
  if (stored !== undefined && stored.byteLength === SALT_BYTES) return stored;

  if (!warnedInvalidPaths.has(path)) {
    warnedInvalidPaths.add(path);
    getSafeLogger()?.warn("credentials", "credential.salt_invalid", { saltPath: path });
  }
  return randomBytes(SALT_BYTES);
}

/** The salt this process fingerprints with, memoised per salt-file path. */
async function resolveSalt(): Promise<Buffer> {
  const path = saltFilePath();
  if (memoSalt !== undefined && memoPath === path) return memoSalt;

  const salt = await loadSalt(path);
  memoPath = path;
  memoSalt = salt;
  return salt;
}

/**
 * The first 12 lowercase hex characters of HMAC-SHA-256 over the credential's
 * identifying secret, keyed by the machine salt.
 *
 * `api-key` fingerprints its `key` as written — a `$VAR` or `!command` template
 * is fingerprinted as the template, because nax-ai documents `key` as opaque.
 * `oauth` fingerprints its `refresh` token, so access-token rotation is
 * invisible while refresh-token rotation is not.
 */
export async function fingerprintCredential(credential: StoredCredential): Promise<string> {
  const salt = await resolveSalt();
  const secret = credential.kind === "api-key" ? credential.key : credential.refresh;
  return createHmac("sha256", salt).update(secret).digest("hex").slice(0, FINGERPRINT_CHARS);
}
