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
export { type Client, type ClientOptions, type ClientRequest, createClient } from "./client.ts";
export { collectStream, ProtocolStreamError } from "./protocols/collect.ts";
export {
  type BackendId,
  type BackendSelection,
  createRegistry,
  type ProtocolBackends,
  type ProtocolEntries,
  UnknownProtocolError,
  UnregisteredBackendError,
} from "./protocols/registry.ts";
export { clampThinkingLevel } from "./protocols/thinking.ts";
export type {
  CacheRetention,
  ConversationMessage,
  JsonSchema,
  Protocol,
  ProtocolError,
  ProtocolEvent,
  ProtocolRequest,
  ThinkingLevel,
  ToolCall,
  ToolDefinition,
} from "./protocols/types.ts";
export { type Catalog, normaliseCatalog, type RawModel, type RawProvider } from "./providers/catalog.ts";
export type {
  Pricing,
  ProviderAuth,
  ProviderOverride,
  ResolvedModel,
  ResolvedProvider,
} from "./providers/types.ts";
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
