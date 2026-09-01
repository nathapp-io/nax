/**
 * Obtaining and managing credentials, in nax's vocabulary.
 *
 * This file and its siblings are the only place in src/ permitted to import
 * nax-ai (scripts/check-nax-ai-imports.ts). Nothing it exports carries a
 * nax-ai type, so src/cli/auth.ts can consume it without breaching that gate.
 */

import { ambientAuthAvailable, type LoginEvent, type LoginInteraction, type LoginPrompt, login } from "@nathapp/nax-ai";
import { NaxError } from "@/errors";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthResult } from "./auth-types";
import { naxCredentialStore } from "./credentials";

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
    if (error.name === "LoginCancelledError") return new AuthCancelledError(providerId);
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
