import type { ProviderId } from "../types.ts";
import type { LoginMethod } from "./login-types.ts";

/**
 * The provider offers no login method this package can run — either none at
 * all, or not the one the caller named. Distinct from a policy refusal, which
 * raises OAuthFlowProhibitedError: an absence and a prohibition send a reader
 * to different problems.
 */
export class AuthMethodUnavailableError extends Error {
  readonly providerId: ProviderId;
  // Declared as `| undefined` rather than optional: under
  // exactOptionalPropertyTypes, assigning a possibly-undefined parameter to an
  // optional field is a type error.
  readonly requested: LoginMethod | undefined;

  constructor(providerId: ProviderId, requested?: LoginMethod) {
    super(
      requested === undefined
        ? `Provider "${providerId}" offers no login method this package can run.`
        : `Provider "${providerId}" does not offer "${requested}" login.`,
    );
    this.name = "AuthMethodUnavailableError";
    this.providerId = providerId;
    this.requested = requested;
  }
}

/** The user cancelled, or the caller aborted. Not a failure. */
export class LoginCancelledError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    super(`Login to "${providerId}" was cancelled.`);
    this.name = "LoginCancelledError";
    this.providerId = providerId;
  }
}

/** The flow ran and did not produce a usable credential. */
export class LoginFailedError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId, reason: string) {
    super(`Login to "${providerId}" failed: ${reason}`);
    this.name = "LoginFailedError";
    this.providerId = providerId;
  }
}
