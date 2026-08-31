/**
 * Which OAuth flows this package is permitted to register.
 *
 * The underlying client (pi-ai) bundles OAuth flows for several providers
 * behind a single lazy loader, including Anthropic's. Reaching the Anthropic
 * flow is therefore only ever one call away from reaching a permitted one,
 * which is why this policy is an explicit allowlist enforced by a gate rather
 * than a convention maintained by review.
 *
 * Anthropic subscription OAuth (Pro/Max tokens outside the official CLI) is
 * both server-blocked and a Consumer ToS violation. It is not "broken and may
 * come back" — it is prohibited, and must never be registered here regardless
 * of whether it happens to work on a given day. Subscription traffic to Claude
 * belongs on a path that uses the official CLI, not on this client.
 */

import type { ProviderId } from "../types.ts";

/**
 * OAuth flows this package may register.
 *
 * Additions are a policy decision, not a routine change: each entry is a
 * provider whose terms permit third-party OAuth use, or whose flow is a
 * first-party developer credential rather than a consumer subscription.
 */
export const PERMITTED_OAUTH_FLOWS: readonly ProviderId[] = Object.freeze([
  "openai-codex",
  "github-copilot",
  "openrouter",
]);

/**
 * OAuth flows that must never be registered, with the reason recorded so a
 * future reader does not "fix" the omission.
 */
export const PROHIBITED_OAUTH_FLOWS: Readonly<Record<ProviderId, string>> = Object.freeze({
  anthropic:
    "Anthropic subscription OAuth outside the official Claude CLI is server-blocked and a Consumer ToS violation. Route Claude subscription traffic through the official CLI instead.",
});

export class OAuthFlowProhibitedError extends Error {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId, reason: string) {
    super(`OAuth flow for "${providerId}" is prohibited: ${reason}`);
    this.name = "OAuthFlowProhibitedError";
    this.providerId = providerId;
  }
}

export function isOAuthFlowPermitted(providerId: ProviderId): boolean {
  return PERMITTED_OAUTH_FLOWS.includes(providerId);
}

/**
 * Throws if `providerId` names a flow this package must not register.
 *
 * Prohibited flows raise a specific error; merely-unknown flows raise a
 * generic one, so a typo is distinguishable from a policy breach.
 */
export function assertOAuthFlowPermitted(providerId: ProviderId): void {
  const prohibitedReason = PROHIBITED_OAUTH_FLOWS[providerId];
  if (prohibitedReason !== undefined) {
    throw new OAuthFlowProhibitedError(providerId, prohibitedReason);
  }
  if (!isOAuthFlowPermitted(providerId)) {
    throw new Error(`Unknown OAuth flow "${providerId}". Permitted flows: ${PERMITTED_OAUTH_FLOWS.join(", ")}.`);
  }
}
