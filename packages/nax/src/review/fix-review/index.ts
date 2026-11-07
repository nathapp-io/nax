/**
 * Fix-review module barrel.
 *
 * Exports the two working-tree helpers the scoped fix review runs on:
 * `snapshotWorkingTree` and `changedPathsBetween` (from `./tree-snapshot`).
 * Both throw on a git failure rather than returning an empty result, and both
 * are the only symbols this module makes public — the verdict / op-output
 * types, the model-resolution helper and the scope check belonged to the
 * fix-review operation deleted in US-001 (pipeline-review-delete).
 */

export { changedPathsBetween, snapshotWorkingTree } from "./tree-snapshot";
