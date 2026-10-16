import type { StoredEntry } from "@nathapp/nax-agent";

export interface AuthReloginNotice {
  readonly providerId: string;
  readonly agent: string;
  readonly message: string;
}

/** Stored entry is absent for credentials supplied by the environment or a helper. */
export function authReloginHint(providerId: string, credential: StoredEntry | undefined, now: number): string {
  if (credential?.kind === "oauth" && credential.expires !== undefined && credential.expires > now)
    return `Login for ${providerId} was rejected before its recorded expiry (expires ${new Date(credential.expires).toISOString()}). Run: nax auth login ${providerId}`;
  if (credential?.kind === "oauth") return `Login for ${providerId} was rejected. Run: nax auth login ${providerId}`;
  if (credential?.kind === "api-key")
    return `API key for ${providerId} was rejected. Check or replace it: nax auth login ${providerId} (or nax auth import)`;
  return `Credentials for ${providerId} were rejected. Check where they come from with: nax auth list`;
}
