/**
 * Shared forge module — the only public entry point.
 *
 * `scripts/check-alias-internals.ts` forbids alias imports that reach past this
 * barrel, so consumers import from `@/forge` and never `@/forge/detect`.
 */

export { defaultForgeDeps } from "./deps";
export { detectForge, forgeFromRemoteUrl, remoteHost } from "./detect";
export type { OpenPrInput, OpenPrResult } from "./pr";
export { extractUrl, hasOpenPr, openPr, viewArgv } from "./pr";
export { encodeProjectPath, repoSlugFromRemoteUrl, resolvePrRef } from "./pr-read";
export type {
  CurrentUser,
  OwnComment,
  PostedComment,
  PrComment,
  PrCommentKind,
  PrInfo,
  PrRef,
  PrState,
  PrThread,
  PrTrust,
} from "./pr-types";
export { findPrTemplate } from "./template";
export type { BodySection, MergeOptions, TemplateMode } from "./template-merge";
export { DEFAULT_SECTION_ALIASES, mergeTemplate } from "./template-merge";
export type { ForgeDeps, ForgeKind, ForgeRunResult } from "./types";
