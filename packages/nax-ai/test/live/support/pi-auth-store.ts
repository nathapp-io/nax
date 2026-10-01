// test/live/support/pi-auth-store.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CredentialStore, StoredCredential } from "../../../src/types.ts";

const DEFAULT_PATH = join(homedir(), ".pi", "agent", "auth.json");

/** pi's on-disk shape. `type` is snake_case there and kebab-case in nax-ai. */
interface PiEntry {
  readonly type?: string;
  readonly key?: string;
  readonly access?: string;
  readonly refresh?: string;
  readonly expires?: number;
  readonly env?: Readonly<Record<string, string>>;
}

function toStored(entry: PiEntry | undefined): StoredCredential | undefined {
  if (entry === undefined) return undefined;
  if (entry.type === "api_key" && typeof entry.key === "string") {
    return { kind: "api-key", key: entry.key, ...(entry.env !== undefined ? { env: entry.env } : {}) };
  }
  if (
    entry.type === "oauth" &&
    typeof entry.access === "string" &&
    typeof entry.refresh === "string" &&
    typeof entry.expires === "number"
  ) {
    // pi carries provider extras such as accountId alongside these three. They
    // are dropped because nax-ai's StoredCredential does not model them, which
    // is safe for openai-codex specifically: pi re-derives the account id from
    // the access token's JWT claim rather than reading the stored field.
    return { kind: "oauth", access: entry.access, refresh: entry.refresh, expires: entry.expires };
  }
  return undefined;
}

/**
 * Reads pi's own credential file so the live suite can record against
 * providers the operator has already authenticated, including OAuth ones no
 * environment variable can carry.
 */
export function piAuthStore(path: string = DEFAULT_PATH): CredentialStore {
  const readAll = (): Record<string, PiEntry> => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, PiEntry>;
    } catch {
      return {};
    }
  };

  const refuse = (): never => {
    throw new Error(
      "piAuthStore is read-only: pi runs OAuth refresh inside modify(), and writing back from a test could drop a rotated refresh token and break the operator's pi login. Refresh through pi's own CLI first, then re-run.",
    );
  };

  return {
    read: async (providerId) => toStored(readAll()[providerId]),
    modify: async () => refuse(),
    delete: async () => refuse(),
  };
}
