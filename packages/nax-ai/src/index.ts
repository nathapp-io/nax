/**
 * @nathapp/nax-ai — provider-agnostic LLM client.
 *
 * Status: pre-1.0, API unstable. Published under the `next` dist-tag.
 *
 * Scope boundary: this package speaks a generic LLM vocabulary — models,
 * messages, tool calls, usage, credentials. It deliberately knows nothing
 * about any consumer's domain concepts (stories, operations, sessions,
 * permission policy). Consumers map onto their own types at their boundary.
 * Keeping that direction one-way is what allows the implementation beneath
 * this surface to be replaced — provider by provider — without consumers
 * noticing.
 */

export {
  assertOAuthFlowPermitted,
  isOAuthFlowPermitted,
  OAuthFlowProhibitedError,
  PERMITTED_OAUTH_FLOWS,
  PROHIBITED_OAUTH_FLOWS,
} from "./auth/oauth-policy.ts";
export type {
  CompleteOptions,
  CompleteResult,
  CredentialStore,
  Message,
  MessageRole,
  ModelRef,
  ProviderId,
  StopReason,
  StoredCredential,
  TokenUsage,
} from "./types.ts";

export { toTokenUsage, totalTokens, type UpstreamUsage } from "./usage.ts";
