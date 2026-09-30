/**
 * Public API of the per-folder trust gate (US-001): the store and the path
 * matching over it. The registry, prompt and entry gate land in US-002, the
 * CLI surfaces in US-003/004.
 */

export { findCoveringEntry, normalizeTrustPath, resolveTrustRoot } from "./match";
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
