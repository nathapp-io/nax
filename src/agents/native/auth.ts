/**
 * Obtaining and managing credentials, in nax's vocabulary.
 *
 * This file and its siblings are the only place in src/ permitted to import
 * nax-ai (scripts/check-nax-ai-imports.ts). Nothing it exports carries a
 * nax-ai type, so src/cli/auth.ts can consume it without breaching that gate.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ambientAuthAvailable, type LoginEvent, type LoginInteraction, type LoginPrompt, login } from "@nathapp/nax-ai";
import { NaxError } from "@/errors";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthResult } from "./auth-types";
import { naxCredentialStore, readStoredEntries, type StoredEntry } from "./credentials";

/**
 * Deliberately dumb: the two vocabularies are one-for-one by design, so this
 * is a rename boundary rather than a translation with opinions. Both sides use
 * kebab-case, so the names pass straight through.
 */
export function toLoginInteraction(interaction: AuthInteraction): LoginInteraction {
  return {
    prompt: async (prompt: LoginPrompt) => interaction.prompt(prompt as AuthPrompt),
    notify: (event: LoginEvent) => interaction.notify(event as AuthEvent),
  };
}

/**
 * Cancellation is not a failure, and the CLI needs to tell them apart to exit
 * 130 silently. A marker class rather than a code match: an exit status should
 * not depend on message text.
 */
export class AuthCancelledError extends Error {
  constructor(readonly providerId: string) {
    super(`Login for "${providerId}" was cancelled`);
    this.name = "AuthCancelledError";
  }
}

/** Test seam, following the _clientDeps precedent. */
export const _authDeps = { login, ambientAuthAvailable };

/**
 * nax-ai's errors are mapped here rather than in the CLI, so its type names
 * stay behind this directory's boundary.
 *
 * A prohibited flow keeps its message: the recorded reason is the whole point
 * of the policy file, and a generic failure would discard it.
 */
function toNaxError(error: unknown, providerId: string): Error {
  if (error instanceof Error) {
    // Nax's own prompts reject with PromptCancelledError from inside the
    // interaction callback, so it surfaces here rather than being converted
    // by nax-ai's login() — that conversion only fires on an aborted signal,
    // and runLogin never threads one.
    if (error.name === "LoginCancelledError" || error.name === "PromptCancelledError") {
      return new AuthCancelledError(providerId);
    }
    if (error.name === "OAuthFlowProhibitedError") {
      return new NaxError(error.message, "AUTH_OAUTH_PROHIBITED", { providerId });
    }
    if (error.name === "AuthMethodUnavailableError") {
      return new NaxError(`No login method is available for "${providerId}".`, "AUTH_METHOD_UNAVAILABLE", {
        providerId,
      });
    }
    return new NaxError(`Login for "${providerId}" failed: ${error.message}`, "AUTH_LOGIN_FAILED", { providerId });
  }
  return new NaxError(`Login for "${providerId}" failed.`, "AUTH_LOGIN_FAILED", { providerId });
}

/**
 * Obtain a credential and write it to the store.
 *
 * No `method` is passed: when a provider offers both, nax-ai runs its own
 * selection prompt. Duplicating that table here is how the two drift apart.
 *
 * The result is reported exactly as returned. kind is never derived from
 * method — M5's design predicted openrouter would report kind "api-key" and
 * its live run reported "oauth".
 */
export async function runLogin(providerId: string, interaction: AuthInteraction): Promise<AuthResult> {
  try {
    const result = await _authDeps.login({
      providerId,
      credentials: naxCredentialStore(),
      interaction: toLoginInteraction(interaction),
    });
    return { providerId: result.providerId, method: result.method, kind: result.kind };
  } catch (error) {
    throw toNaxError(error, providerId);
  }
}

export const DEFAULT_PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

export interface ImportOutcome {
  providerId: string;
  status: "imported" | "skipped" | "unsupported";
}

type PiEntry = { type?: string; key?: string; access?: string; refresh?: string; expires?: number };

/**
 * pi's on-disk shape is flat and snake-cased; the store's is versioned and
 * kebab-cased. accountId is deliberately dropped: pi derives it from the
 * access-token JWT at request time rather than trusting what is stored, and
 * nax-ai's own credential round-trip already drops it.
 */
function fromPiEntry(
  entry: PiEntry,
): { kind: "api-key"; key: string } | { kind: "oauth"; access: string; refresh: string; expires: number } | undefined {
  if (entry.type === "api_key" && typeof entry.key === "string") {
    return { kind: "api-key", key: entry.key };
  }
  if (
    entry.type === "oauth" &&
    typeof entry.access === "string" &&
    typeof entry.refresh === "string" &&
    typeof entry.expires === "number"
  ) {
    return { kind: "oauth", access: entry.access, refresh: entry.refresh, expires: entry.expires };
  }
  return undefined;
}

/**
 * Bring pi's credentials across.
 *
 * Existing entries are skipped rather than overwritten: import plausibly runs
 * after a fresh login, and silently replacing a credential just obtained would
 * be the worst kind of quiet data loss.
 *
 * The presence check happens inside modify()'s callback, not before it: that
 * is what holds the store's cross-process lock across the whole
 * read-modify-write. Deciding "already present" from a separate, unlocked
 * read would race a concurrent login completing between the two calls.
 */
export async function importPiCredentials(options?: { from?: string; force?: boolean }): Promise<ImportOutcome[]> {
  const path = options?.from ?? DEFAULT_PI_AUTH_PATH;

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NaxError(`No credential file to import at ${path}.`, "AUTH_IMPORT_SOURCE_MISSING", {
        path,
        cause: error,
      });
    }
    throw new NaxError(`The file at ${path} could not be read.`, "AUTH_IMPORT_SOURCE_UNREADABLE", {
      path,
      cause: error,
    });
  }

  let parsed: Record<string, PiEntry>;
  try {
    parsed = JSON.parse(raw) as Record<string, PiEntry>;
  } catch (error) {
    throw new NaxError(`The file at ${path} is not valid JSON.`, "AUTH_IMPORT_SOURCE_UNREADABLE", {
      path,
      cause: error,
    });
  }

  const store = naxCredentialStore();
  const outcomes: ImportOutcome[] = [];

  for (const providerId of Object.keys(parsed).sort()) {
    const entry = parsed[providerId];
    const credential = entry === undefined ? undefined : fromPiEntry(entry);
    if (credential === undefined) {
      outcomes.push({ providerId, status: "unsupported" });
      continue;
    }
    let status: "imported" | "skipped" = "imported";
    await store.modify(providerId, async (existing) => {
      if (existing !== undefined && options?.force !== true) {
        status = "skipped";
        return existing;
      }
      return credential;
    });
    outcomes.push({ providerId, status });
  }

  return outcomes;
}

export async function listStoredProviders(): Promise<StoredEntry[]> {
  return readStoredEntries();
}

/**
 * Removal, not revocation. pi has no revocation anywhere — its own types
 * define logout as deletion — so the provider-side token stays live until it
 * expires. Callers must not describe this as logging out.
 */
export async function removeStoredProvider(providerId: string): Promise<void> {
  await naxCredentialStore().delete(providerId);
}

export function authImportOutcomeLabel(status: ImportOutcome["status"]): string {
  if (status === "imported") return "imported";
  if (status === "skipped") return "skipped, already present";
  return "unsupported credential type";
}

/**
 * Of these providers, which would ambient auth satisfy on its own?
 *
 * A stored credential owns its provider in pi's resolution order, so any
 * provider named here has a working environment variable that the stored
 * credential is shadowing. This only ever decorates a diagnostic, so a failing
 * probe reports nothing rather than breaking the command around it.
 */
export async function ambientShadows(providerIds: readonly string[]): Promise<string[]> {
  const checked = await Promise.all(
    providerIds.map(async (providerId) => {
      try {
        return (await _authDeps.ambientAuthAvailable(providerId)) ? providerId : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return checked.filter((id): id is string => id !== undefined);
}
