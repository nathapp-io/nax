/**
 * Shared forge module — the only public entry point.
 *
 * `scripts/check-alias-internals.ts` forbids alias imports that reach past this
 * barrel, so consumers import from `@/forge` and never `@/forge/detect`.
 */

export type { InlineCommentInput } from "./comments";
export {
  editComment,
  MAX_FORGE_COMMENT_CHARS,
  postInlineComment,
  postPrComment,
  replyToThread,
  resolveThread,
} from "./comments";
export { defaultForgeDeps } from "./deps";
export { detectForge, forgeFromRemoteUrl, remoteHost } from "./detect";
export type { LinkedIssue } from "./issues";
export { MAX_LINKED_ISSUES, parseClosingRefs, readIssue, readLinkedIssues } from "./issues";
export { findOwnComments, NAX_BOT_HEADER, ownComments, parseNaxBotMarker, withNaxBotMarker } from "./marker";
export type { OpenPrInput, OpenPrResult } from "./pr";
export { extractUrl, hasOpenPr, openPr, viewArgv } from "./pr";
export { encodeProjectPath, readPrInfo, repoSlugFromRemoteUrl, resolvePrRef } from "./pr-read";
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
export { listPrComments, listReviewThreads, MAX_FORGE_PAGES } from "./threads";
export { classifyPrTrust, readCurrentUser } from "./trust";
export type { ForgeDeps, ForgeKind, ForgeRunResult } from "./types";
