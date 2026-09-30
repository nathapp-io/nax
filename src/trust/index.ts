/**
 * Public API of the per-folder trust gate: the store and the path matching over
 * it (US-001), the process registry, the prompt and the entry gate (US-002).
 * The CLI surfaces land in US-003/004.
 */

export { _trustGateDeps, ensureProjectTrusted } from "./gate";
export { findCoveringEntry, normalizeTrustPath, resolveTrustRoot } from "./match";
export { _trustPromptDeps, promptTrustChoice } from "./prompt";
export { assertTrusted, markTrusted, resetTrustRegistry } from "./registry";
export {
  _trustStoreDeps,
  addTrustEntry,
  readTrustStore,
  removeTrustEntry,
  TrustStoreFileSchema,
  trustStorePath,
} from "./store";
export type {
  AddTrustResult,
  RemoveTrustResult,
  TrustChoice,
  TrustEntry,
  TrustStoreFile,
  TrustStoreRead,
  TrustSurface,
} from "./types";
