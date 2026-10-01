/**
 * The vocabulary of a login, in nax-ai's own terms.
 *
 * pi-ai's equivalents are snake_case (`auth_url`, `device_code`, `manual_code`,
 * `api_key`); these are kebab-case, matching `ProtocolError.kind`'s
 * `rate-limit` and `bad-request`. That translation is the boundary: it is what
 * keeps a rename upstream from becoming a breaking change here.
 */

import type { CredentialStore, ProviderId, StoredCredential } from "../types.ts";

export type LoginMethod = "api-key" | "oauth";

export interface LoginOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

/**
 * `signal` cancels this one prompt — a flow uses it when an out-of-band event
 * resolves the step, e.g. a manual-code prompt raced against a callback
 * server. It is not the whole login's signal, which lives on `LoginOptions`.
 */
export type LoginPrompt = { readonly signal?: AbortSignal } & (
  | { readonly type: "text"; readonly message: string; readonly placeholder?: string }
  | { readonly type: "secret"; readonly message: string; readonly placeholder?: string }
  | { readonly type: "select"; readonly message: string; readonly options: readonly LoginOption[] }
  | { readonly type: "manual-code"; readonly message: string; readonly placeholder?: string }
);

export interface LoginLink {
  readonly url: string;
  readonly label?: string;
}

export type LoginEvent =
  | { readonly type: "info"; readonly message: string; readonly links?: readonly LoginLink[] }
  | { readonly type: "auth-url"; readonly url: string; readonly instructions?: string }
  | {
      readonly type: "device-code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly intervalSeconds?: number;
      readonly expiresInSeconds?: number;
    }
  | { readonly type: "progress"; readonly message: string };

/**
 * Login interaction, serving both api-key and OAuth flows.
 *
 * `prompt()` returns the entered text or, for `select`, the chosen option id.
 * Reject it to cancel.
 */
export interface LoginInteraction {
  prompt(prompt: LoginPrompt): Promise<string>;
  notify(event: LoginEvent): void;
}

export interface LoginOptions {
  readonly providerId: ProviderId;
  readonly credentials: CredentialStore;
  readonly interaction: LoginInteraction;
  /** Skips the method prompt. Throws if the named method is unavailable. */
  readonly method?: LoginMethod;
  readonly signal?: AbortSignal;
}

/**
 * Metadata, deliberately not the credential: `login()` has already written it
 * to the store, and returning the secret would create a second copy with no
 * consumer. A caller that cannot obtain it cannot leak it.
 */
export interface LoginResult {
  readonly providerId: ProviderId;
  readonly method: LoginMethod;
  readonly kind: StoredCredential["kind"];
}
