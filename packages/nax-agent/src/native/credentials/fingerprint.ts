/**
 * Keyed credential fingerprints (US-002).
 *
 * A fingerprint lets a run report "the credential this call was billed to has
 * changed" without ever logging the credential: the first 12 lowercase hex
 * characters of HMAC-SHA-256 over the credential's identifying secret, keyed by
 * a per-machine salt held in `<configDir>/auth-fingerprint-salt`.
 *
 * The salt is what makes the digest useless as a lookup key, and it is per
 * machine by design — a fingerprint cannot be compared across machines. It is
 * published atomically at mode 0600, so a writer that loses the creation race
 * reads the winner's complete file instead of overwriting it.
 */

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StoredCredential } from "@nathapp/nax-ai";
import { errorMessage } from "#src/infra/errors";
import { credentialsConfig, getSafeLogger } from "#src/infra/index";

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
  return join(credentialsConfig().configDir(), SALT_FILENAME);
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
 * Create the salt file with its bytes already in place, or read the winner's
 * when another writer beat us to it.
 *
 * `open(path, "wx")` publishes the name before the payload lands, so a process
 * that lost the creation race could read a 0-byte file, call it invalid and
 * fingerprint with an in-memory salt nobody else on the machine shares. Staging
 * the bytes and hard-linking them into place publishes the name only once the
 * content exists: `link` fails with EEXIST when another writer got there first,
 * and a hard link shares the inode, mode 0600 included.
 *
 * The staging name is unique per attempt, so two concurrent callers inside one
 * process cannot overwrite each other's bytes.
 */
async function createSaltFile(path: string): Promise<Buffer | undefined> {
  // A fresh machine has no global config dir yet, and an exclusive create cannot
  // make one: an absent parent surfaces as ENOENT, not EEXIST, so the first
  // fingerprint would throw instead of creating the salt.
  await mkdir(dirname(path), { recursive: true });

  const candidate = randomBytes(SALT_BYTES);
  const staged = `${path}.${randomUUID()}.staged`;
  try {
    await writeFile(staged, candidate, { mode: 0o600 });
    try {
      await link(staged, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return readSaltFile(path);
      throw error;
    }
    return candidate;
  } finally {
    await rm(staged, { force: true });
  }
}

/**
 * Load the machine salt, creating it on first use.
 *
 * A file that is not exactly 32 bytes is left untouched: it is replaced by a
 * random in-memory salt for this process, and `credential.salt_invalid` is
 * logged once for that path. Rewriting the file would destroy whatever an
 * operator put there, and reusing a short read would be worse than a fresh key.
 *
 * Any filesystem failure resolves the same way. This runs on the run-start probe
 * (`providersWithoutCredentials`), where a raw `EACCES`/`EISDIR` would escape as a
 * non-`NaxError` and take the whole precheck report down with it.
 *
 * The trade is deliberate and it is a real loss: a random salt breaks the
 * cross-process comparison on THIS machine, which is the one thing a per-machine
 * salt exists to provide (fingerprints still cannot cross machines either way —
 * that is what the salt buys). So a run whose `~/.nax` is unwritable reports
 * `credential.changed`/`credential.renewed` against a baseline no sibling process
 * shares, and its `auth` fingerprints do not line up with the next run's. The
 * errno rides along on the event so an operator can tell a permissions problem
 * from a truncated file, which is the difference between a fixable machine and a
 * mysterious one.
 */
async function loadSalt(path: string): Promise<Buffer> {
  let stored: Buffer | undefined;
  let failure: unknown;
  try {
    stored = (await readSaltFile(path)) ?? (await createSaltFile(path));
  } catch (error) {
    stored = undefined;
    failure = error;
  }
  if (stored !== undefined && stored.byteLength === SALT_BYTES) return stored;

  if (!warnedInvalidPaths.has(path)) {
    warnedInvalidPaths.add(path);
    getSafeLogger()?.warn("credentials", "credential.salt_invalid", {
      saltPath: path,
      ...(failure !== undefined
        ? { errno: (failure as NodeJS.ErrnoException).code, error: errorMessage(failure) }
        : {}),
    });
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
 * The part of a credential that identifies it.
 *
 * Exhaustive over the union on purpose: a third `StoredCredential` kind must
 * fail the build here, not silently hash whichever field the `else` branch
 * happened to name.
 */
function identifyingSecret(credential: StoredCredential): string {
  switch (credential.kind) {
    case "api-key":
      return credential.key;
    case "oauth":
      return credential.refresh;
  }
}

/**
 * The first 12 lowercase hex characters of HMAC-SHA-256 over the credential's
 * identifying secret, keyed by the machine salt.
 *
 * `api-key` fingerprints its `key` as written — a `$VAR` or `!command` template
 * is fingerprinted as the template, because nax-ai documents `key` as opaque.
 * `oauth` fingerprints its `refresh` token, so access-token rotation is
 * invisible while refresh-token rotation is not.
 *
 * `salt` overrides the machine salt file: an in-process caller that keeps its own
 * key (a session store) passes one, and a supplied salt never touches the slot.
 */
export async function fingerprintCredential(credential: StoredCredential, salt?: Buffer): Promise<string> {
  const key = salt ?? (await resolveSalt());
  const secret = identifyingSecret(credential);
  return createHmac("sha256", key).update(secret).digest("hex").slice(0, FINGERPRINT_CHARS);
}
