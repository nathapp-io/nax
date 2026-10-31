/**
 * Shared forge module — the only public entry point.
 *
 * `scripts/check-alias-internals.ts` forbids alias imports that reach past this
 * barrel, so consumers import from `@/forge` and never `@/forge/detect`.
 */

export { hasWriteAccess, type WriterCheck, writerCheck } from "./access";
export type { ForgeCheck, ForgeCheckStatus } from "./checks-read";
export { listHeadChecks } from "./checks-read";
export type { FailedCheck } from "./ci-failures";
export {
  CI_EXCERPT_CHARS,
  CI_EXCERPT_LINES,
  ciExcerpt,
  MAX_FAILED_CHECKS,
  prNumberFromUrl,
  readFailedChecks,
} from "./ci-failures";
export type { InlineCommentInput, ItemCommentInput } from "./comments";
export {
  editComment,
  MAX_FORGE_COMMENT_CHARS,
  postInlineComment,
  postItemComment,
  postPrComment,
  replyToThread,
  resolveThread,
  unresolveThread,
} from "./comments";
export { defaultForgeDeps } from "./deps";
export { detectForge, forgeFromRemoteUrl, remoteHost } from "./detect";
export type { InjectedForgeIdentity } from "./identity";
export {
  _forgeIdentity,
  _forgeIdentityDeps,
  captureForgeIdentity,
  FORGE_IDENTITY_ENV,
  injectedForgeIdentity,
} from "./identity";
export type { LinkedIssue } from "./issues";
export { MAX_LINKED_ISSUES, parseClosingRefs, readIssue, readLinkedIssues } from "./issues";
export type { JobLogRead } from "./job-log";
export { CI_ANNOTATION_CHARS, CI_ANNOTATION_LINES, readJobLog, stripAnsi } from "./job-log";
export {
  findOwnComments,
  hasNaxWorkflowMarker,
  isNaxBotMarkerKey,
  NAX_BOT_HEADER,
  NAX_WORKFLOW_PR_MARKER,
  ownComments,
  parseNaxBotMarker,
  stripNaxBotMarkers,
  withNaxBotMarker,
} from "./marker";
export { TOP_LEVEL_MARKER_KEYS } from "./marker-grammar";
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
