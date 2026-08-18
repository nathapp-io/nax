/**
 * Shared forge module — the only public entry point.
 *
 * `scripts/check-alias-internals.ts` forbids alias imports that reach past this
 * barrel, so consumers import from `@/forge` and never `@/forge/detect`.
 */
export type { ForgeDeps, ForgeKind, ForgeRunResult } from "./types";
export { detectForge, forgeFromRemoteUrl, remoteHost } from "./detect";
export type { OpenPrInput, OpenPrResult } from "./pr";
export { extractUrl, hasOpenPr, openPr, viewArgv } from "./pr";
export { findPrTemplate } from "./template";
