/**
 * The native LLM path: nax's own client, in-process, over @nathapp/nax-ai.
 *
 * This directory is the only place in src/ permitted to import nax-ai
 * (scripts/check-nax-ai-imports.ts). nax composes it into its AgentAdapter in
 * `src/agents/native-agent/`, so the wire library stays replaceable.
 *
 * The barrel re-exports only; it owns no values. NATIVE_AGENT lives in
 * models.ts (a leaf) so session-adapter.ts can import it without a cycle back
 * through this file — `check:import-cycles` runs against a baseline and a new
 * cycle fails it.
 */

export { _adapterDeps } from "./adapter-deps";
export {
  AuthCancelledError,
  ambientShadows,
  anyAmbientCredential,
  authImportOutcomeLabel,
  DEFAULT_PI_AUTH_PATH,
  type ImportOutcome,
  importPiCredentials,
  listStoredProviders,
  providersWithoutCredentials,
  removeStoredProvider,
  runLogin,
} from "./auth";
export type {
  AuthEvent,
  AuthInteraction,
  AuthLink,
  AuthMethod,
  AuthOption,
  AuthPrompt,
  AuthResult,
} from "./auth-types";
export type { NativeCatalogOverrides } from "./client";
export {
  type NativeCompleteContext,
  type NativeCompleteOptions,
  type NativeCompleteResult,
  nativeComplete,
} from "./complete";
export { credentialFilePath, naxCredentialStore, type StoredEntry, servedAuth } from "./credentials";
export { NativeSessionUnsupportedError } from "./errors";
export {
  type ResolveResult,
  type ResolveStatus,
  resolveNativeId,
} from "./model-resolver";
export { NATIVE_AGENT } from "./models";
export {
  MAX_RETAINED_TRANSCRIPTS,
  pruneRetainedTranscripts,
} from "./session/transcript-store";
export { NativeSessionAdapter } from "./session-adapter";
export { newSessionKey } from "./session-affinity";
export { type NativeTierConfig, nativeTierProviders } from "./tier-providers";
