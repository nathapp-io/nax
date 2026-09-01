/**
 * Obtaining and managing credentials, in nax's vocabulary.
 *
 * This file and its siblings are the only place in src/ permitted to import
 * nax-ai (scripts/check-nax-ai-imports.ts). Nothing it exports carries a
 * nax-ai type, so src/cli/auth.ts can consume it without breaching that gate.
 */

import type { LoginEvent, LoginInteraction, LoginPrompt } from "@nathapp/nax-ai";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "./auth-types";

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
