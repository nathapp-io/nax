/**
 * The credential store, and the one place that reads its file directly.
 *
 * This directory is the only place in src/ permitted to import nax-ai
 * (packages/repo-tooling/scripts/check-nax-ai-imports.ts).
 *
 * The store is memoised like client.ts's client: createFileCredentialStore
 * holds a cross-process lock, and two instances over one path would each take
 * it, turning a read-modify-write into a contended wait for no reason.
 *
 * US-004 assembles the chain the run reads through — the change guard (US-002)
 * around the chained store (exec helper first, file second) — and exports
 * `servedAuth` so a cost row can name the account a call was billed to. Its
 * callers (client.ts:84, auth.ts:121/:204/:238) are synchronous and
 * the configured auth reader is async, so the chain is built on the first
 * read/modify/delete and reused for the rest of the process.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileCredentialStore, type ProviderId } from "@nathapp/nax-ai";
import { credentialsConfig, NaxError } from "#src/infra/index";
import type { AuthStamp } from "#src/session/session-types";
import { createChainedCredentialStore } from "./chained-store";
import { createChangeGuard, type GuardedCredentialStore } from "./change-guard";
import { createExecCredentialSource } from "./exec-source";
import { _resetFingerprintSalt } from "./fingerprint";

export type { GuardedCredentialStore } from "./change-guard";

/** One credential's public facts. Deliberately carries no key. */
export interface StoredEntry {
  providerId: string;
  kind: "api-key" | "oauth";
  expires?: number;
}

export function credentialFilePath(): string {
  return join(credentialsConfig().configDir(), "credentials");
}

/**
 * Build the chain from the global auth config: a chained store either around
 * the exec helper (when `auth.source` is "exec") or around the file store
 * alone, wrapped in the change guard the run reports and refuses through.
 *
 * The guard's `describe` reports what the chain decided — which source served
 * the provider and, for a helper lease, the account label that source reported.
 * The account travels beside `read`, not through it: `StoredCredential` has no
 * field for it.
 */
async function assembleStore(): Promise<GuardedCredentialStore> {
  const file = createFileCredentialStore({ path: credentialFilePath() });
  const auth = await credentialsConfig().readAuthConfig();
  const exec =
    auth.source === "exec" && auth.exec !== undefined
      ? createExecCredentialSource({ command: auth.exec.command, timeoutMs: auth.exec.timeoutMs })
      : undefined;
  const chained = createChainedCredentialStore(exec === undefined ? { file } : { exec, file });

  return createChangeGuard(chained, {
    onChange: auth.onChange,
    describe: (providerId) => {
      const source = chained.sourceOf(providerId);
      if (source === undefined) return undefined;
      const account = chained.accountOf(providerId);
      return account === undefined ? { source } : { source, account };
    },
  });
}

/**
 * The store handed out by `naxCredentialStore()`, with its chain deferred.
 *
 * Deferred because the factory must be synchronous, and kept once built because
 * the exec source holds leases and the file store holds a cross-process lock: a
 * `config.json` rewritten in the same directory is not re-read until
 * `_resetCredentialStore()`.
 */
function lazyStore(): GuardedCredentialStore {
  let inner: GuardedCredentialStore | undefined;
  let pending: Promise<GuardedCredentialStore> | undefined;

  function resolved(): Promise<GuardedCredentialStore> {
    if (inner !== undefined) return Promise.resolve(inner);
    if (pending === undefined) {
      // Dropped on failure, like a failed catalog build in client.ts: a
      // transient read must not poison every later call in the process. `inner`
      // is what `servedAuth` reads, so it is set as soon as the chain exists.
      pending = assembleStore()
        .then((guard) => {
          inner = guard;
          return guard;
        })
        .catch((err: unknown) => {
          pending = undefined;
          throw err;
        });
    }
    return pending;
  }

  return {
    read: async (providerId) => (await resolved()).read(providerId),
    modify: async (providerId, fn) => (await resolved()).modify(providerId, fn),
    delete: async (providerId) => (await resolved()).delete(providerId),
    // Synchronous by contract, and there is nothing to report until the chain
    // has built itself — which only a read, modify or delete does.
    servedAuth: (providerId) => inner?.servedAuth(providerId),
  };
}

/**
 * The store the run reads credentials through, keyed per credential-file path
 * and global config path: a store pinned to a stale path would write outside
 * the temp dir a test isolated it into.
 */
let memo: { key: string; store: GuardedCredentialStore } | undefined;

function storeKey(): string {
  const dir = credentialsConfig().configDir();
  return `${join(dir, "credentials")}\u0000${join(dir, "config.json")}`;
}

export function naxCredentialStore(): GuardedCredentialStore {
  const key = storeKey();
  if (memo === undefined || memo.key !== key) {
    memo = { key, store: lazyStore() };
  }
  return memo.store;
}

/**
 * Clears the memo. Tests only. Dropping it drops the assembled chain with it —
 * the guard, its exec source and the file store it wraps — and the salt memo
 * the fingerprints are keyed by.
 */
export function _resetCredentialStore(): void {
  memo = undefined;
  _resetFingerprintSalt();
}

/**
 * What the memoised store last observed for `providerId` — the identity a
 * successful call was billed to. `undefined` until that provider has been read.
 */
export function servedAuth(providerId: ProviderId): AuthStamp | undefined {
  return naxCredentialStore().servedAuth(providerId);
}

/**
 * Is the run configured to take credentials from an exec helper?
 *
 * Asked by `NativeAgentAdapter.hasCredentials`, which cannot list a helper's
 * providers: with `auth.source: "exec"` an empty credential file must not be
 * read as "no credentials", and asking the helper there would spawn it before
 * the run has any reason to. Read straight from the global config rather than
 * from the store's assembly, because this is answered before the store is ever
 * read.
 */
export async function authSourceIsExec(): Promise<boolean> {
  return (await credentialsConfig().readAuthConfig()).source === "exec";
}

/**
 * Enumerate the store by reading its file.
 *
 * CredentialStore is read/modify/delete by design and has no list, and this is
 * the only consumer that needs one. A parse failure throws rather than
 * reporting an empty store: reporting empty would look exactly like "you have
 * no credentials" for a file that is merely damaged.
 */
export async function readStoredEntries(): Promise<StoredEntry[]> {
  const path = credentialFilePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NaxError(
      `The credential file at ${path} could not be parsed. Refusing to read it.`,
      "CREDENTIAL_FILE_UNREADABLE",
      { stage: "credentials", path },
    );
  }

  const credentials = (parsed as { credentials?: Record<string, { kind?: string; expires?: number }> })?.credentials;
  if (
    credentials === undefined ||
    credentials === null ||
    typeof credentials !== "object" ||
    Array.isArray(credentials)
  ) {
    throw new NaxError(
      `The credential file at ${path} could not be parsed as a credential store.`,
      "CREDENTIAL_FILE_UNREADABLE",
      { stage: "credentials", path },
    );
  }

  return Object.entries(credentials)
    .map(([providerId, value]) => {
      const kind = value?.kind === "oauth" ? ("oauth" as const) : ("api-key" as const);
      const entry: StoredEntry = { providerId, kind };
      if (kind === "oauth" && typeof value?.expires === "number") entry.expires = value.expires;
      return entry;
    })
    .sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0));
}
