/**
 * The credential store, and the one place that reads its file directly.
 *
 * This directory is the only place in src/ permitted to import nax-ai
 * (scripts/check-nax-ai-imports.ts).
 *
 * The store is memoised like client.ts's client: createFileCredentialStore
 * holds a cross-process lock, and two instances over one path would each take
 * it, turning a read-modify-write into a contended wait for no reason.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type CredentialStore, createFileCredentialStore } from "@nathapp/nax-ai";
import { globalConfigDir } from "@/config";
import { NaxError } from "@/errors";

/** One credential's public facts. Deliberately carries no key. */
export interface StoredEntry {
  providerId: string;
  kind: "api-key" | "oauth";
  expires?: number;
}

export function credentialFilePath(): string {
  return join(globalConfigDir(), "credentials");
}

let cached: CredentialStore | undefined;
let cachedPath: string | undefined;

export function naxCredentialStore(): CredentialStore {
  const path = credentialFilePath();
  // Rebuild when the path changes: NAX_GLOBAL_CONFIG_DIR moves between tests,
  // and a store pinned to a stale path would write outside the temp dir.
  if (cached === undefined || cachedPath !== path) {
    cached = createFileCredentialStore({ path });
    cachedPath = path;
  }
  return cached;
}

/** Clears the memo. Tests only. */
export function _resetCredentialStore(): void {
  cached = undefined;
  cachedPath = undefined;
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
      { path },
    );
  }

  const credentials = (parsed as { credentials?: Record<string, { kind?: string; expires?: number }> })?.credentials;
  if (credentials === undefined || typeof credentials !== "object") {
    throw new NaxError(
      `The credential file at ${path} could not be parsed as a credential store.`,
      "CREDENTIAL_FILE_UNREADABLE",
      { path },
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
