/**
 * nax's own login vocabulary.
 *
 * A deliberate mirror of nax-ai's LoginInteraction family. It exists so the
 * CLI can implement a terminal interaction without importing nax-ai, which
 * scripts/check-nax-ai-imports.ts confines to this directory. The mapper in
 * auth.ts is the only translation point, so a rename upstream is a one-file
 * change here.
 *
 * This module imports nothing. That is what keeps it a leaf, so the barrel can
 * re-export it without creating an import cycle.
 */

export type AuthMethod = "api-key" | "oauth";

export interface AuthOption {
  id: string;
  label: string;
  description?: string;
}

export type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly AuthOption[] }
  | { type: "manual-code"; message: string; placeholder?: string }
);

export interface AuthLink {
  url: string;
  label?: string;
}

export type AuthEvent =
  | { type: "info"; message: string; links?: readonly AuthLink[] }
  | { type: "auth-url"; url: string; instructions?: string }
  | {
      type: "device-code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

/** `prompt` returns the entered text, or for `select` the chosen option id. Reject to cancel. */
export interface AuthInteraction {
  prompt(prompt: AuthPrompt): Promise<string>;
  notify(event: AuthEvent): void;
}

/** Metadata only. The credential is written to the store and never returned. */
export interface AuthResult {
  providerId: string;
  method: AuthMethod;
  kind: "api-key" | "oauth";
}
