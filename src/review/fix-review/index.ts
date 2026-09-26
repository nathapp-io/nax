/**
 * Fix-review module barrel (US-001 + US-002).
 *
 * The verdict / op-output types and the model-resolution helper that the
 * scoped fix review and its consumers (US-003, US-004, US-005) share (US-001),
 * plus the working-tree snapshot / path-diff / scope-classification helpers
 * the US-003+ fix review calls (US-002).
 */

export { resolveFixReviewModel } from "./config";
export type { FixScopeInput, FixScopeResult } from "./scope";
export { checkFixScope } from "./scope";
export { changedPathsBetween, diffBetween, snapshotWorkingTree } from "./tree-snapshot";
export type { FixReviewOpOutput, FixReviewRequest, FixReviewVerdict } from "./types";
