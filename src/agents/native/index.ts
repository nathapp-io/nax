/**
 * The native LLM path: nax's own client, in-process, over @nathapp/nax-ai.
 *
 * This directory is the only place in src/ permitted to import nax-ai
 * (scripts/check-nax-ai-imports.ts). Everything outside it consumes the
 * AgentAdapter interface, so the wire library stays replaceable.
 *
 * The barrel re-exports only; it owns no values. NATIVE_AGENT lives in
 * models.ts (a leaf) so adapter.ts can import it without a cycle back through
 * this file — `check:import-cycles` runs against a baseline and a new cycle
 * fails it.
 */

export { NativeAgentAdapter } from "./adapter";
export {
  AuthCancelledError,
  ambientShadows,
  authImportOutcomeLabel,
  DEFAULT_PI_AUTH_PATH,
  type ImportOutcome,
  importPiCredentials,
  listStoredProviders,
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
export { credentialFilePath, naxCredentialStore, type StoredEntry } from "./credentials";
export { NativeSessionUnsupportedError } from "./errors";
export { NATIVE_AGENT } from "./models";
