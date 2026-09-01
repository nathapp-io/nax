/**
 * Obtaining a credential, as opposed to holding or using one.
 *
 * This module never imports pi-ai: every provider-specific step is behind a
 * LoginRunner that pi-auth.ts resolved. The credential is written to the
 * caller's store before this returns, and never handed back.
 */

import type { ProviderId, StoredCredential } from "../types.ts";
import { AuthMethodUnavailableError, LoginCancelledError, LoginFailedError } from "./login-errors.ts";
import type { LoginMethod, LoginOptions, LoginResult } from "./login-types.ts";
import { OAuthFlowProhibitedError } from "./oauth-policy.ts";
import { type LoginRunner, resolveLoginTarget } from "./pi-auth.ts";

/** Test seam. */
export const _resolveTarget = { resolve: resolveLoginTarget };

type Choice = { method: LoginMethod; runner: LoginRunner };

async function select(available: readonly Choice[], options: LoginOptions, signal: AbortSignal): Promise<Choice> {
  const { providerId, method, interaction } = options;

  if (method !== undefined) {
    const named = available.find((choice) => choice.method === method);
    if (named === undefined) throw new AuthMethodUnavailableError(providerId, method);
    return named;
  }

  const only = available.length === 1 ? available[0] : undefined;
  if (only !== undefined) return only;

  const answer = await interaction.prompt({
    type: "select",
    message: `How do you want to sign in to "${providerId}"?`,
    options: available.map((choice) => ({ id: choice.method, label: choice.runner.label })),
    ...(signal !== undefined ? { signal } : {}),
  });

  const picked = available.find((choice) => choice.method === answer);
  // An unrecognised answer is not a reason to guess: falling back to the first
  // method would bill against a credential path the user did not choose.
  if (picked === undefined) throw new AuthMethodUnavailableError(providerId);
  return picked;
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

/**
 * A credential whose key is empty is not a credential. The store would accept
 * it and every later call would fail with an auth error pointing nowhere near
 * this login.
 */
function assertUsable(credential: StoredCredential, providerId: ProviderId): void {
  if (credential.kind === "api-key" && credential.key.length === 0) {
    throw new LoginFailedError(providerId, "the flow returned an empty API key");
  }
}

export async function login(options: LoginOptions): Promise<LoginResult> {
  const { providerId, credentials, interaction, signal } = options;
  const target = await _resolveTarget.resolve(providerId);

  const available: Choice[] = [];
  if (target.apiKey !== undefined) available.push({ method: "api-key", runner: target.apiKey });
  if (target.oauth !== undefined) available.push({ method: "oauth", runner: target.oauth });

  if (available.length === 0) throw new AuthMethodUnavailableError(providerId);

  const abort = signal ?? new AbortController().signal;

  let chosen: Choice;
  let credential: StoredCredential;
  try {
    chosen = await select(available, options, abort);
    credential = await chosen.runner.run(interaction, abort);
  } catch (error) {
    // A policy refusal keeps its own identity: its recorded reason is the
    // point, and a generic failure would discard it.
    if (error instanceof OAuthFlowProhibitedError) throw error;
    if (isCancellation(error, abort)) throw new LoginCancelledError(providerId);
    throw error;
  }

  assertUsable(credential, providerId);

  // modify, never a bare write: it is what holds the store's lock across the
  // whole read-modify-write.
  await credentials.modify(providerId, async () => credential);

  return { providerId, method: chosen.method, kind: credential.kind };
}
