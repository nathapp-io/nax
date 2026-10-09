/**
 * The native LLM path: nax's own client, in-process, over @nathapp/nax-ai.
 *
 * This directory is the only place in src/ permitted to import nax-ai
 * (packages/repo-tooling/scripts/check-nax-ai-imports.ts). nax composes it into its AgentAdapter in
 * `src/agents/native-agent/`, so the wire library stays replaceable.
 *
 * The barrel re-exports only; it owns no values. NATIVE_AGENT lives in
 * models.ts (a leaf) so session-adapter.ts can import it without a cycle back
 * through this file — `check:import-cycles` runs against a baseline and a new
 * cycle fails it.
 */

export { _adapterDeps } from "./adapter-deps.ts";
export {
  AuthCancelledError,
  ambientShadows,
  anyAmbientCredential,
  authImportOutcomeLabel,
  DEFAULT_PI_AUTH_PATH,
  type ImportOutcome,
  importPiCredentials,
  listStoredProviders,
  loginProviderIds,
  providersWithoutCredentials,
  removeStoredProvider,
  runLogin,
} from "./auth.ts";
export type {
  AuthEvent,
  AuthInteraction,
  AuthLink,
  AuthMethod,
  AuthOption,
  AuthPrompt,
  AuthResult,
} from "./auth-types.ts";
export type { NativeCatalogOverrides } from "./client.ts";
export {
  type NativeCompleteContext,
  type NativeCompleteOptions,
  type NativeCompleteResult,
  nativeComplete,
} from "./complete.ts";
export { credentialFilePath, naxCredentialStore, type StoredEntry, servedAuth } from "./credentials/index.ts";
export { NativeSessionUnsupportedError } from "./errors.ts";
export {
  type ResolveResult,
  type ResolveStatus,
  resolveNativeId,
} from "./model-resolver.ts";
export { NATIVE_AGENT } from "./models.ts";
export { createMemoryTranscriptStore, type MemoryTranscriptStore } from "./session/memory-transcript-store.ts";
export {
  createFileTranscriptStore,
  MAX_RETAINED_TRANSCRIPTS,
  pruneRetainedTranscripts,
} from "./session/transcript-store.ts";
export type { TranscriptAcpRecord, TranscriptDoc, TranscriptStore, TurnMarker } from "./session/transcript-types.ts";
export { NativeSessionAdapter } from "./session-adapter.ts";
export { newSessionKey } from "./session-affinity.ts";
export { type NativeTierConfig, nativeTierProviders } from "./tier-providers.ts";
